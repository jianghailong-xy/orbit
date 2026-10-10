#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged; see README.md): the slice of the Orbit API the native chat
# page and a project's pages read, for one project — "Recap everywhere" (P1) — whose coordinator S1
# and member S2 the server has recapped, whose member S3 has only a reply, and a session S4 in no
# project, all in one workspace:
#
#   (`projectId` is the coordinator's own relation, as the server serves it: only S1 carries it, and
#   every member carries `projectMembership` — the shape the apps' coordinator badge reads.)
#
#   S1  P1's COORDINATOR, parked: recapText + recapAt (minutes old) + lastAssistantText — the chat
#       page photographed, the project row's line, the sessions page's coordinator row and the
#       project page's coordinator card.
#   S2  a member of P1, parked, recapped forty minutes ago, with its own reply.
#   S3  a member of P1, parked, a reply and no recap — the fallback the entries keep.
#   S4  in no project, recapped — an ordinary list row beside the project's.
#
# Started with `--recaps-off`, GET /api/users/me answers `preferences.recaps: false` — the same
# account with its Session recaps switch off. One flag on the same stub, so the "switch off"
# pictures are the same app against the same data; the mode heads every log line.
#
# The coordinator status read (GET /api/projects/P1/coordinator/status) is served the way the
# apiserver serves it: the conversation's state and times, and none of its words — the card's line
# comes from the session list's own row, which is what the pictures are of.
#
# Every request is logged; anything not served is a 404 and is counted in not-served.txt. All data
# is made up.
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
ARGS = sys.argv[3:]
RECAPS_OFF = "--recaps-off" in ARGS
for _arg in ARGS:
    if _arg != "--recaps-off":
        raise SystemExit("stub.py: unknown argument %r (the only flag is --recaps-off)" % _arg)


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
PROJECT = "P1"
PROJECT_TITLE = "Recap everywhere"

# The sentences the pictures are read by. Recaps are the server's shape: one line, at most 80
# characters (apiserver `RECAP_MAX_CHARS`).
COORD_TITLE = "Coordinate the recap"
COORD_RECAP = "Landed the chat-page recap on all three clients; the shots are next."
COORD_REPLY = "Filed the evidence task and pinged the reviewer."
MEMBER_TITLE = "Coordinator card line"
MEMBER_RECAP = "Wired the coordinator card to the session list's own line."
MEMBER_REPLY = "Pushed the card change."
PLAIN_TITLE = "Fixture rebase"
PLAIN_REPLY = "Rebased the fixtures; the suite is green."
OTHER_TITLE = "Drawer shadow fix"
OTHER_RECAP = "Softened the drawer's shadow and re-ran the web suite."
OTHER_REPLY = "Pushed the drawer fix."
# S1's conversation, which the chat page draws under its recap.
ASKED = "Put the recap at the top of the chat page and on the project's entries."
ANSWERED = "Done on all three clients: the header line, the coordinator card and the project row."

# Minutes old at the stub's start, so the chat page reads "Recap · 5m ago" for the first minute of
# a pass and "Recap · <n>m ago" after it — the test asserts the shape, not the number.
COORD_RECAP_AT = ago(5)
MEMBER_RECAP_AT = ago(40)
OTHER_RECAP_AT = ago(22)


def preferences():
    # Absent means on (`UserPreferences.showRecaps`): the on pass carries no `recaps` key at all.
    return {"theme": "system", "recaps": False} if RECAPS_OFF else {"theme": "system"}


USER = {"id": "u1", "email": "hailong@example.com", "name": "Hailong", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": preferences()}
RUNNER = {"id": "r1", "name": "longdeMac-mini.local", "displayName": "longdeMac-mini.local",
          "online": True, "status": "ONLINE", "version": "0.1.226", "maxConcurrent": 4,
          "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.296", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "orbit-macos", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/orbit",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}


def membership(role):
    return {"projectId": PROJECT, "projectTitle": PROJECT_TITLE, "projectStatus": "OPEN", "role": role}


def session(sid, title, minutes_ago, **extra):
    """One Open-list row, parked (AWAITING_INPUT) in every status field the model resolves between."""
    row = {"id": sid, "publicId": sid, "title": title,
           "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT", "runState": "AWAITING_INPUT",
           "sessionState": "AWAITING_INPUT", "lifecycleState": "OPEN",
           "agentId": "a1", "agent": {"id": "a1", "name": "orbit-macos"},
           "assignedRunnerId": "r1", "provider": "claude", "model": "claude-opus-5-5", "effort": "max",
           "permissionMode": "default", "taskId": None, "projectId": None, "projectTitle": None,
           "createdAt": ago(minutes_ago + 600), "updatedAt": ago(minutes_ago),
           "lastTurnAt": ago(minutes_ago), "pendingApprovals": 0, "tags": [], "folderId": None,
           "source": "USER"}
    row.update(extra)
    return row


SESSIONS = {
    "S1": session("S1", COORD_TITLE, 4, projectId=PROJECT, projectTitle=PROJECT_TITLE,
                  projectMembership=membership("COORDINATOR"), lastAssistantText=COORD_REPLY,
                  recapText=COORD_RECAP, recapAt=COORD_RECAP_AT),
    "S2": session("S2", MEMBER_TITLE, 38, projectMembership=membership("TASK"), lastAssistantText=MEMBER_REPLY,
                  recapText=MEMBER_RECAP, recapAt=MEMBER_RECAP_AT),
    "S3": session("S3", PLAIN_TITLE, 90, projectMembership=membership("TASK"), lastAssistantText=PLAIN_REPLY),
    "S4": session("S4", OTHER_TITLE, 20, lastAssistantText=OTHER_REPLY,
                  recapText=OTHER_RECAP, recapAt=OTHER_RECAP_AT),
}
MEMBERS = ["S1", "S2", "S3"]


def events(sid):
    """S1's conversation: what was asked and what was answered. The others have none — nobody opens them."""
    if sid != "S1":
        return []
    return [
        {"seq": 1, "type": "user", "ts": ago(9), "turnId": "t1", "payload": {"text": ASKED}},
        {"seq": 2, "type": "assistant", "ts": ago(6), "turnId": "t1",
         "payload": {"text": ANSWERED, "messageId": "m1"}},
        {"seq": 3, "type": "result", "ts": ago(6), "turnId": "t1",
         "payload": {"subtype": "success", "result": "done"}},
    ]


def summary():
    """P1 as the projects list and the sidebar read it (the crossings probe's shape, which the
    native clients decode): open, started, five tasks of which two are done."""
    return {"id": PROJECT, "publicId": PROJECT, "title": PROJECT_TITLE, "status": "OPEN",
            "goal": "Show the recap wherever a session is entered.", "createdAt": ago(20 * DAY),
            "updatedAt": ago(30), "lastActivityAt": ago(4), "_count": {"tasks": 5},
            "startedAt": ago(19 * DAY), "taskCounts": {"done": 2, "failed": 0, "total": 5}}


def task(tid, title, status, level=0):
    return {"id": tid, "publicId": tid, "title": title, "status": status, "parentTaskId": None, "childCount": 0,
            "unmetCount": 0, "blocksCount": 0, "topoLevel": level, "dependencyState": "READY",
            "workState": "IDLE", "completionPolicy": "MANUAL", "autoRunWhenReady": True}


TASKS = [task("T1", "Recap on the chat page", "DONE"), task("T2", "Recap on the coordinator card", "DONE"),
         task("T3", "Recap on the project row", "OPEN"), task("T4", "Screenshots", "OPEN", 1),
         task("T5", "Evidence", "OPEN", 1)]


def document():
    by_status = {}
    for t in TASKS:
        by_status[t["status"]] = by_status.get(t["status"], 0) + 1
    return {"id": PROJECT, "publicId": PROJECT, "title": PROJECT_TITLE, "status": "OPEN",
            "goal": "Show the recap wherever a session is entered: the chat page and the project's entries.",
            "instructions": "Probe instructions.", "createdAt": ago(20 * DAY), "updatedAt": ago(30),
            "coordinatorEnabled": True, "configRevision": "1", "coordinatorSessionId": "S1",
            "_count": {"tasks": len(TASKS)}, "tasksByStatus": by_status,
            "acceptanceCriteriaItems": [],
            "blockers": {"open": [], "resolved": [], "resolvedCount": 0},
            "startedAt": ago(19 * DAY), "pausedAt": None, "maxConcurrentTasks": 3}


def coordinator_status():
    """GET /api/projects/P1/coordinator/status as the apiserver answers it (projects.service
    `coordinatorSessionState`): the conversation's state and stamps, and no words of it."""
    s = SESSIONS["S1"]
    return {"projectId": PROJECT, "readAt": ago(0), "state": "LIVE",
            "coordination": {
                "sessionId": "S1", "sessionIdAbsentReason": None,
                "session": {"id": "S1", "title": COORD_TITLE, "runStatus": "AWAITING_INPUT",
                            "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "filingState": "OPEN",
                            "endReason": None, "endReasonAbsentReason": "SESSION_NOT_ENDED",
                            "startedAt": s["createdAt"], "startedAtAbsentReason": None,
                            "finishedAt": None, "finishedAtAbsentReason": "SESSION_STILL_RUNNING",
                            "completedAt": None, "completedAtAbsentReason": "SESSION_NOT_COMPLETED",
                            "deletedAt": None, "deletedAtAbsentReason": "SESSION_NOT_TRASHED",
                            "lastTurnAt": s["lastTurnAt"], "lastTurnAtAbsentReason": None,
                            "engineTurnActive": False, "pendingApprovals": 0},
                "sessionAbsentReason": None, "coordinatorGeneration": "0",
                "workspaceId": "a1", "workspaceIdAbsentReason": None,
                "workspaceName": "orbit-macos", "workspaceNameAbsentReason": None,
                "agentId": "a1", "agentIdAbsentReason": None, "agentName": "orbit-macos",
                "agentNameAbsentReason": None,
                "wakeups": {"state": "DELIVERED", "at": ago(4)},
                "fuse": {"selfStartedToday": 2, "limit": 30, "paused": False, "episodeId": None}},
            "openability": {"canOpen": True, "willCreate": False, "refusalCode": None, "refusalDetail": None,
                            "requiredAction": None, "landing": {"workspaceId": "a1", "workspaceName": "orbit-macos"}}}


# Endpoints the signed-in shells ask for on their own. An empty list where the app expects a list —
# what a new account gets — is enough; a read the probe did not think of is a counted 404.
EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications",
         "tasks", "skills", "share-links"]


def log(line):
    with open(LOG, "a") as f:
        f.write("%s [%s] %s\n" % (datetime.now().strftime("%H:%M:%S"),
                                  "recaps-off" if RECAPS_OFF else "recaps-on", line))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log(fmt % args)

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
            return self.keepalive()
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
        if parts == ["api", "sessions"]:
            view = query.get("view", ["open"])[0]
            if view != "open":
                return self.send(200, [])
            scoped = query.get("projectId", [None])[0]
            ids = MEMBERS if scoped == PROJECT else list(SESSIONS)
            return self.send(200, [SESSIONS[i] for i in ids] if scoped in (None, PROJECT) else [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, rest = parts[2], parts[3:]
            if sid not in SESSIONS:
                return self.missing()
            if rest == []:
                return self.send(200, SESSIONS[sid])
            if rest == ["events"]:
                return self.stream(sid, int(query.get("sinceSeq", ["0"])[0] or 0))
            if rest == ["events", "page"]:
                return self.send(200, {"events": events(sid), "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
            if rest[0] in ("retry-message", "capabilities", "owner-confirmation", "watches",
                           "attribution", "created-tasks"):
                return self.send(200, {})
            if rest == ["owner-items"]:
                return self.send(200, {"needsYou": [], "withCoordinator": []})
            return self.missing()
        if parts == ["api", "projects"]:
            return self.send(200, [summary()])
        if parts == ["api", "projects", "sidebar"]:
            return self.send(200, [summary()])
        if len(parts) >= 3 and parts[:2] == ["api", "projects"] and parts[2] == PROJECT:
            rest = parts[3:]
            if rest == []:
                return self.send(200, document())
            if rest == ["coordinator", "status"]:
                return self.send(200, coordinator_status())
            if rest == ["tasks", "page"]:
                return self.send(200, {"items": TASKS, "nextCursor": None})
            if rest == ["handoffs"]:
                return self.send(200, [])
            if rest == ["open-items"]:
                return self.send(200, {"needsYou": [], "withCoordinator": []})
            return self.missing()
        if parts == ["api", "wiki", "spaces"]:
            return self.send(200, [])
        if parts == ["api", "access-tokens"]:
            return self.send(200, {"tokens": []})
        if parts[:1] == ["api"] and len(parts) >= 2 and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        if parts == ["api", "tasks", "page"]:
            return self.send(200, {"items": [], "nextCursor": None})
        return self.missing()

    def missing(self):
        log("NOT SERVED %s" % self.path)
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def keepalive(self):
        """The control stream with nothing to say: keepalives inside the clients' watchdog."""
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

    def stream(self, sid, sent):
        """A conversation's stream: replay what follows `sinceSeq` (the server's `data:` frames),
        then hold it open with keepalives. Nothing new ever arrives."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for e in events(sid):
                if e["seq"] > sent:
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
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode(errors="replace") if n else ""
        if parts == ["__reset"]:
            log("RESET (nothing is mutable in this stub)")
            return self.send(200, {"ok": True})
        log("BODY %s %s" % (self.path, raw))
        # The probe presses nothing; a write it does not know about is a bug in the probe.
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def refuse(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode(errors="replace") if n else ""
        log("BODY %s %s" % (self.path, raw))
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    do_PATCH = refuse
    do_PUT = refuse
    do_DELETE = refuse


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on macOS
    # raises the "find devices on local networks" prompt over the app being photographed.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    log("stub on :%d recaps=%s args=[%s] pid=%d" % (PORT, "OFF" if RECAPS_OFF else "on",
                                                     " ".join(ARGS), os.getpid()))
    Server(("127.0.0.1", PORT), Handler).serve_forever()
