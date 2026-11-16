#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API a real ConsoleModel reads to
# draw the owner exception card ("Who fixes it?", docs/mocks/owner-exception-who-fixes), for the
# board's escalated merge conflict on project "Checkout v2".
#
#   usage: stub.py PORT LOG VARIANT      (VARIANT also from $PROBE_VARIANT; default "a")
#
#   a  unreachable: no ASK_COORDINATOR_AGAIN, coordinatorUnreachable true, chat refused; the
#      coordinator is LIVE in workspace W1 "mac-mini", which is disabled -> WORKSPACE_DISABLED.
#   b  reachable: ASK_COORDINATOR_AGAIN listed, coordinatorUnreachable false, chat open -> ESCALATED.
#
# Every request is logged; anything not served is a 404 and lands in not-served.txt. All data is
# made up.
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"
VARIANT = (sys.argv[3] if len(sys.argv) > 3 else os.environ.get("PROBE_VARIANT", "a")).lower()


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
PROJECT = "P1"
TITLE = "Checkout v2"
TASK_TITLE = "Retry failed webhook deliveries"
TASK_ID = "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9"
TASK_SESSION = "489fc485-949c-533a-9b56-7712a68762ef"
FILES = [
    "src/webhooks/sender.ts",
    "src/webhooks/sender.test.ts",
    "src/webhooks/retry-policy.ts",
    "src/queue/backoff.ts",
    "src/queue/backoff.test.ts",
    "src/config/defaults.ts",
    "docs/webhooks.md",
    "package.json",
    "package-lock.json",
]

USER = {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "mac-mini.local", "displayName": "mac-mini.local",
          "online": True, "status": "ONLINE", "version": "0.1.120", "maxConcurrent": 4,
          "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
# The coordinator's workspace: disabled underneath a LIVE coordinator (variant a's cause).
WORKSPACE = {"id": "W1", "name": "mac-mini", "provider": "claude", "lastProvider": "claude",
             "runnerId": "r1", "enabled": False, "enableWorktree": True, "effort": "",
             "workDir": "/srv/checkout", "appendSystemPrompt": "", "workDirExists": True,
             "workDirIsGit": True}

SESSION = {
    "id": "S1", "publicId": "S1", "title": "Coordinator", "status": "FAILED",
    "runStatus": "FAILED", "runState": "FAILED", "sessionState": "FAILED",
    "agentId": "W1", "assignedRunnerId": "r1", "provider": "claude",
    "taskId": None, "projectId": PROJECT, "projectTitle": TITLE,
    "error": None, "sourceState": "UNBOUND",
    "runClaimedAt": ago(200), "engineStartedAt": ago(200), "numTurns": 3,
    "createdAt": ago(2 * DAY), "updatedAt": ago(5),
}


def row():
    reachable = VARIANT == "b"
    actions = ["OPEN_TASK_SESSION", "OPEN_LANDING", "CANCEL_TASK"]
    if reachable:
        actions = ["ASK_COORDINATOR_AGAIN"] + actions
    return {
        "itemId": "I1", "kind": "INTEGRATION_CONFLICT",
        "title": "Merge conflict: " + TASK_TITLE,
        "detailLine": "9 files conflict with project/35aK2xQm",
        "assignee": "OWNER", "assigneeReason": "ESCALATED",
        # Board ②: 3h 1m waiting, escalated 5m ago (2h 56m of it with the coordinator).
        "waitingSince": ago(181), "escalateAt": None, "escalatedAt": ago(5),
        "taskId": TASK_ID, "sessionId": TASK_SESSION, "landingSessionId": "35aLanding00000000001",
        "promotionId": None, "fuseEpisodeId": None,
        "delivery": {"state": "DELIVERED", "sessionId": "S1", "at": ago(180)},
        "actions": actions,
        "requiredAction": "This task cannot reach the project branch until its merge conflict is "
                          "repaired — fix the task branch" + (" or ask the coordinator to do it." if reachable else "."),
        "question": None,
        "facts": {
            "task": {"id": TASK_ID, "title": TASK_TITLE},
            "targetRef": "refs/heads/project/35aK2xQm8LrT0vHcE1pZq",
            "targetSha": "9f3c2e1aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5",
            "files": FILES, "nothingLanded": False, "check": None, "branchUnchanged": False,
            "errorCode": None, "failure": None,
        },
        "chat": {"sessionId": "S1", "stage": "WITH_OWNER",
                 "refusal": None if reachable else "COORDINATOR_UNAVAILABLE"},
        "coordinatorUnreachable": not reachable,
    }


def promotion_row():
    """Variant p: a project-branch-to-main check that timed out after 4h, reachable coordinator.
    `branchLine` is the sentence the server writes for a promotion's Branch row."""
    return {
        "itemId": "I1", "kind": "INTEGRATION_CHECK_FAILED",
        "title": "Checks failed on the combined tree: merging the project branch into main",
        "detailLine": "the merge check timed out",
        "assignee": "OWNER", "assigneeReason": "ESCALATED",
        "waitingSince": ago(181), "escalateAt": None, "escalatedAt": ago(5),
        "taskId": None, "sessionId": None, "landingSessionId": "35aLanding00000000001",
        "promotionId": "35aPromo0000000000001", "fuseEpisodeId": None,
        "delivery": {"state": "DELIVERED", "sessionId": "S1", "at": ago(180)},
        "actions": ["ASK_COORDINATOR_AGAIN", "RETRY", "OPEN_LANDING"],
        "requiredAction": "The project branch cannot reach main until this check finishes — re-run it "
                          "with a reason or ask the coordinator to fix it.",
        "question": None,
        "facts": {
            "task": None, "targetRef": None, "targetSha": None, "files": [], "nothingLanded": False,
            "check": {"name": "MERGE_CHECK", "command": "npm run test -w @orbit/apiserver",
                      "expectedExitCode": 0, "exitCode": None, "timedOut": True,
                      "durationMs": 14400000, "outputTail": "", "timeoutSeconds": 14400},
            "branchUnchanged": True,
            "branchLine": "unchanged — the project branch did not move, and nothing reached main",
            "errorCode": None, "failure": None,
        },
        "chat": {"sessionId": "S1", "stage": "WITH_OWNER", "refusal": None},
        "coordinatorUnreachable": False,
    }


def document():
    return {"id": PROJECT, "publicId": PROJECT, "title": TITLE, "status": "OPEN",
            "goal": "Checkout v2 ships with retried webhook deliveries.",
            "instructions": "", "createdAt": ago(20 * DAY), "updatedAt": ago(30),
            "coordinatorEnabled": True, "configRevision": "1", "coordinatorSessionId": "S1",
            "exceptionEscalationSeconds": 7200,
            "_count": {"tasks": 3}, "tasksByStatus": {"DONE": 2, "OPEN": 1},
            "acceptanceCriteriaItems": [],
            "blockers": {"open": [], "resolved": [], "resolvedCount": 0},
            "startedAt": ago(19 * DAY), "pausedAt": None, "maxConcurrentTasks": 3}


def coordinator_status():
    return {
        "projectId": PROJECT, "readAt": ago(0), "state": "LIVE",
        "coordination": {
            "sessionId": "S1",
            "session": {"id": "S1", "title": "Coordinator", "runState": "FAILED",
                        "lifecycleState": "OPEN", "engineTurnActive": False, "pendingApprovals": 0,
                        "startedAt": ago(2 * DAY), "finishedAt": None, "completedAt": None},
            "coordinatorGeneration": "0", "workspaceId": "W1", "workspaceName": "mac-mini",
            "agentName": None,
        },
        "openability": {"canOpen": True, "willCreate": False, "refusalCode": None,
                        "refusalDetail": None, "requiredAction": None,
                        "landing": {"workspaceId": None, "workspaceName": None}},
    }


EMPTY_LISTS = ["providers", "providers/mine", "providers/pools", "providers/shared-pools",
               "session-tags", "session-folders", "task-lists", "watches", "tasks/active",
               "notifications", "wiki/spaces"]


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

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts == ["api", "events"]:
            return self.stream()
        if parts == ["api", "users", "me"]:
            return self.send(200, USER)
        if parts == ["api", "agents"]:
            return self.send(200, [WORKSPACE])
        if parts == ["api", "agents", "W1"]:
            return self.send(200, WORKSPACE)
        if parts == ["api", "runners"]:
            return self.send(200, [RUNNER])
        if parts == ["api", "runners", "r1"]:
            return self.send(200, RUNNER)
        if parts == ["api", "sessions"]:
            return self.send(200, [SESSION])
        if parts[:3] == ["api", "sessions", "S1"]:
            more = parts[3:]
            if more == []:
                return self.send(200, SESSION)
            if more[0] == "events":
                return self.send(200, {"items": [], "nextCursor": None, "events": []})
            if more == ["owner-items"]:
                return self.send(200, {"needsYou": [], "withCoordinator": []})
        if parts == ["api", "projects"] or parts == ["api", "projects", "sidebar"]:
            return self.send(200, [])
        if parts[:3] == ["api", "projects", PROJECT]:
            more = parts[3:]
            if more == []:
                return self.send(200, document())
            if more == ["open-items"]:
                return self.send(200, {"needsYou": [promotion_row() if VARIANT == "p" else row()], "withCoordinator": [],
                                       "closedQuestions": []})
            if more == ["coordinator", "status"]:
                return self.send(200, coordinator_status())
        if parts[:1] == ["api"] and "/".join(parts[1:]) in EMPTY_LISTS:
            return self.send(200, [])
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
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode(errors="replace") if n else ""
        self.note("BODY %s %s" % (self.path, raw))
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    do_PATCH = do_POST
    do_DELETE = do_POST


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # No reverse lookup of our own name: on macOS it raises the local-network prompt over the app
    # being photographed (the source-refused probe's lesson).
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    Server(("127.0.0.1", PORT), Handler).serve_forever()
