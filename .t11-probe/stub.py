#!/usr/bin/env python3
"""TEMPORARY evidence probe (shots branch only; see README.md).

The control plane the real iOS app signs in to for T11 (project 34YhlsSkybFDaTXbOfcxM): a stub on
127.0.0.1:8787 (the simulator shares the host's loopback) answering the reads the session list, the
projects list and a coordinator conversation make, over ONE project whose owner's read carries the
three states T10 photographed on the web — the same rows, field for field, from
`t10-server-fixture.json` (so the two ends' pictures can be put side by side):

  escalated   an INTEGRATION_CHECK_FAILED that became the owner's, nobody on it
              → requiredAction, Ask the coordinator again / Re-run the check / Review, the Check row
                (mono command, red verdict) with the log under it, "Owner: you · … · came to the
                owner at …"
  handling    the same item with a repair task linked (handledBy)
              → "The coordinator is fixing this in Repair the combined-tree baseline."
  handedOver  the same item the coordinator handed over, with its note
              → the note inside the requiredAction

Every write a press makes is recorded, body and all, in <STUB_OUT>/writes.jsonl — the evidence of
what the app sends (the two rerun doors carry the reason the card was drawn with; "Mark as handled"
carries the typed one).

Nothing here re-implements the app: it runs unmodified, and this is only the server's side.

usage: stub.py                 serve (env STUB_OUT, STUB_PORT)
       stub.py --dump DIR      write every read, one file per fixture, for a decode check
"""
import json
import os
import socketserver
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("STUB_PORT", "8787"))
OUT = os.environ.get("STUB_OUT", os.getcwd())
T0 = datetime.now(timezone.utc)
LOCK = threading.Lock()


def iso(minutes_ago=0.0):
    """An instant `minutes_ago` before the stub started, the way the server spells one."""
    t = T0 - timedelta(minutes=minutes_ago)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def uid(n):
    return f"0195c0de-0000-7000-8000-{n:012d}"


B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def b62(u):
    """A uuid's public spelling (`PublicID.toPublic`): the 16 bytes as one base62 number."""
    n, out = int(u.replace("-", ""), 16), ""
    while n:
        n, r = divmod(n, 62)
        out = B62[r] + out
    return out or "0"


WIKOVA, AGENT_ID, RUNNER_ID = uid(1), uid(100), uid(200)

PROJECT = "34YhlsSkybFDaTXbOfcxM"
TITLE = "Ship a decision with every exception"
COORD = b62(uid(701))
PROMOTION = b62(uid(710))
REPAIR_TASK = b62(uid(720))

AGENT = {"id": AGENT_ID, "name": "orbit", "lastProvider": "claude", "permissionMode": "default",
         "effort": "", "workDir": "~/orbit", "runnerId": RUNNER_ID, "enabled": True,
         "description": "the office"}

RUNNER = {
    "id": RUNNER_ID, "name": "wikova", "online": True, "version": "0.1.210",
    "runsAsRoot": False, "activeSessions": 1,
    "runtimeDefaultModels": {"claude": "claude-opus-5-5"},
    "engines": [{"engine": "claude", "installed": True, "auth": "yes", "version": "2.1.290"}],
    "modelCatalog": {"claude": [{"value": "claude-opus-5-5", "label": "Opus 5.5"}]},
}

CHECK = {
    "name": "MERGE_CHECK",
    "command": "npm test && go test ./...",
    "expectedExitCode": 0,
    "exitCode": 1,
    "timedOut": False,
    "durationMs": 1609148,
    "outputTail": "--- FAIL: TestCombinedTree\nFAIL",
}

REQUIRED_ESCALATED = ("Nothing on the project branch reaches main until this check passes — re-run "
                      "it or ask the coordinator to fix it.")
REQUIRED_HANDLING = ("A repair task is already handling this item — let it finish or open the task "
                     "to see what it needs.")
HANDOVER_NOTE = "The coordinator cannot safely rerun this candidate until the baseline is repaired."
REQUIRED_HANDED_OVER = ("The coordinator handed this item over with this note: “" + HANDOVER_NOTE
                        + "” — follow it, then use the available door.")
TITLE_ITEM = "Checks failed on the combined tree: merging the project branch into main"
DETAIL = "The combined-tree check returned a failure."


def item(item_id, escalated_at, required, **extra):
    row = {
        "itemId": item_id, "kind": "INTEGRATION_CHECK_FAILED", "title": TITLE_ITEM,
        "detailLine": DETAIL, "assignee": "OWNER", "assigneeReason": "ESCALATED",
        "waitingSince": iso(125), "escalateAt": None, "escalatedAt": escalated_at,
        "taskId": None, "sessionId": COORD, "promotionId": PROMOTION, "fuseEpisodeId": None,
        "delivery": {"state": "NOT_REQUIRED", "sessionId": None, "at": None},
        "question": None,
        "facts": {"task": None, "targetRef": None, "targetSha": None, "files": [],
                  "nothingLanded": False, "check": dict(CHECK), "branchUnchanged": True,
                  "errorCode": None, "failure": None},
        "actions": ["ASK_COORDINATOR_AGAIN", "RETRY", "REVIEW"],
        "requiredAction": required, "primaryAction": "ASK_COORDINATOR_AGAIN",
    }
    row.update(extra)
    return row


def build():
    """The three items, escalated just NOW.

    Their `escalatedAt` sits after the conversation's last event on purpose: an exception card is
    placed by its own moment (`DeliveryAnchor.exception`), so a clock that ran minutes ago puts the
    cards at the TAIL — where the reader opens, and where the bar over the transcript can point DOWN
    at them once they scroll back up ("the reader is above the cards" is the state the bar's
    direction word exists for). The wait itself is two hours, so the footer's two clauses differ.
    """
    s = {}
    s["escalated"] = item("t11-escalated-item", iso(3.5), REQUIRED_ESCALATED)
    s["handling"] = item("t11-handling-item", iso(2.5), REQUIRED_HANDLING, handledBy=[
        {"taskId": REPAIR_TASK, "title": "Repair the combined-tree baseline", "state": "IN_PROGRESS"}])
    s["handedOver"] = item("t11-handed-over-item", iso(1.5), REQUIRED_HANDED_OVER,
                           assigneeReason="HANDED_OVER", handoverNote=HANDOVER_NOTE)
    return s


STATE = build()


def project_doc():
    return {
        "id": PROJECT, "title": TITLE, "status": "OPEN",
        "goal": "Every exception says what to do first, and the doors do it.",
        "instructions": None, "createdAt": iso(4 * 24 * 60), "updatedAt": iso(2),
        "coordinatorEnabled": True, "configRevision": "3", "coordinatorSessionId": COORD,
        "maxConcurrentTasks": 3, "startedAt": iso(3 * 24 * 60), "pausedAt": None,
        "pausedReason": None, "_count": {"tasks": 4}, "tasksByStatus": {"DONE": 3, "OPEN": 1},
        "acceptanceCriteriaItems": [],
        "integration": {"line": "PROJECT_BRANCH", "lineAbsentReason": None,
                        "ref": f"project/{PROJECT}", "upstreamRef": "main", "source": "EXPLICIT",
                        "locked": True, "startedAt": iso(2 * 24 * 60),
                        "mergeCheckCommand": "npm test", "mergeCheckCommandAbsentReason": None,
                        "mergeCheckTimeoutSeconds": None, "escalationSeconds": 7200},
        "blockers": {"open": [], "recentlyResolved": []},
        "derivedDone": {"status": "OPEN", "done": False, "withheld": [], "criteria": [],
                        "confirmation": "CONFIRMED", "counts": None},
        "doneBy": None, "doneAt": None, "doneCriteriaDigest": None, "acceptedGaps": [],
    }


def open_items():
    return {"needsYou": [STATE["escalated"], STATE["handling"], STATE["handedOver"]],
            "withCoordinator": [], "startRequest": None, "doneRequest": None,
            "closedQuestions": [], "settled": [], "mainBranch": "main"}


def promotion():
    return {
        "promotionId": PROMOTION, "state": "READY", "sourceRef": "refs/heads/project/34YhlsSkybFDaTXbOfcxM",
        "sourceSha": "58f3a4711d0c3f2e", "upstreamRef": "refs/heads/main", "commitsAhead": 7,
        "filesChanged": 18, "taskIds": [REPAIR_TASK], "checks": [
            {"name": "MERGE_CHECK", "command": "npm test", "expectedExitCode": 0, "exitCode": 0,
             "timedOut": False, "durationMs": 372_000}],
        "conflicts": [], "landsAs": "MERGE_COMMIT", "askedAt": iso(200), "recheckedAt": None,
        "decidedAt": None, "merged": None, "execution": None,
    }


def summary(last_active):
    return {
        "id": PROJECT, "title": TITLE, "status": "OPEN",
        "goal": project_doc()["goal"], "doneBy": None, "doneAt": None, "acceptedGaps": [],
        "createdAt": iso(4 * 24 * 60), "updatedAt": iso(2), "coordinatorAgentId": AGENT_ID,
        "coordinatorGeneration": "0", "_count": {"tasks": 4},
        "buckets": {"running": 0, "ready": 1, "blocked": 0, "awaitingVerification": 0, "done": 3,
                    "failed": 0, "cancelled": 0},
        "lastActivityAt": iso(last_active),
        "attention": {"userBlockers": 0, "coordinatorBlockers": 0, "systemBlockers": 0,
                      "maxSeverity": None, "attentionSinceAt": None, "nextCheckAt": None,
                      "ownerItems": [{"itemId": STATE["escalated"]["itemId"], "kind": "ESCALATED",
                                      "title": TITLE_ITEM, "since": iso(125), "need": "Checks failed",
                                      "mainBranch": "main"}],
                      "coordinatorItems": None, "startRequest": None, "doneRequest": None},
        "integration": {"line": "PROJECT_BRANCH", "ref": f"project/{PROJECT}"},
    }


def coordinator_session():
    return {
        "id": COORD, "title": TITLE, "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT",
        "sessionState": "AWAITING_INPUT", "runState": "AWAITING_INPUT",
        "lifecycleState": "OPEN", "filingState": "OPEN", "agentId": AGENT_ID,
        "agent": {"id": AGENT_ID, "name": "orbit"}, "assignedRunnerId": RUNNER_ID,
        "provider": "claude", "model": "claude-opus-5-5", "projectId": PROJECT,
        "projectTitle": TITLE,
        "projectMembership": {"projectId": PROJECT, "projectTitle": TITLE,
                              "projectStatus": "OPEN", "role": "COORDINATOR"},
        "taskId": None, "pendingApprovals": 1, "waitingKind": "OWNER_ITEM",
        "ownerItems": [{"itemId": STATE["escalated"]["itemId"], "kind": "ESCALATED",
                        "title": TITLE_ITEM, "since": iso(125), "need": "Checks failed",
                        "mainBranch": "main"}],
        "lastAssistantText": "The combined-tree check is red. I can’t rerun it until the baseline "
                             "is repaired, so it is the owner’s now.",
        "createdAt": iso(600), "updatedAt": iso(4), "lastTurnAt": iso(4),
    }


def coordinator_events():
    return {"events": [
        {"seq": 1, "type": "user", "ts": iso(40), "turnId": "t1",
         "payload": {"text": "What has to happen before this branch can move?"}},
        {"seq": 2, "type": "assistant", "ts": iso(4.2), "turnId": "t1",
         "payload": {"text": "The combined-tree check is red. I can’t rerun it until the baseline "
                             "is repaired, so it is the owner’s now."}},
        {"seq": 3, "type": "result", "ts": iso(4.1), "turnId": "t1", "payload": {"subtype": "success"}},
    ], "hasMore": False}


def integration_view():
    return {"line": "PROJECT_BRANCH", "ref": f"project/{PROJECT}", "upstreamRef": "main",
            "locked": True, "startedAt": iso(2 * 24 * 60), "mergeCheckCommand": "npm test",
            "escalationSeconds": 7200, "commitsAheadOfUpstream": 7, "lastUpstreamSyncAt": iso(20),
            "integratingCount": 0, "queuedCount": 0, "mergeCheckOnTip": "PASSING", "inFlight": None}


def coordinator_status():
    return {
        "projectId": PROJECT, "readAt": iso(0), "state": "LIVE",
        "coordination": {
            "sessionId": COORD, "sessionIdAbsentReason": None,
            "session": {"id": COORD, "title": TITLE, "runStatus": "AWAITING_INPUT",
                        "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "filingState": "OPEN",
                        "endReason": None, "startedAt": iso(600), "finishedAt": None,
                        "completedAt": None, "deletedAt": None, "engineTurnActive": False,
                        "pendingApprovals": 1, "lastTurnAt": iso(4),
                        "lastTurnAtAbsentReason": None},
            "sessionAbsentReason": None, "coordinatorGeneration": "0", "workspaceId": AGENT_ID,
            "workspaceIdAbsentReason": None, "workspaceName": "orbit", "agentId": AGENT_ID,
            "agentName": "orbit", "wakeups": {"state": "DELIVERED", "at": iso(4)},
            "fuse": {"selfStartedToday": 2, "limit": 30, "paused": False, "episodeId": None}},
        "openability": {"canOpen": True, "willCreate": False, "refusalCode": None,
                        "refusalDetail": None, "refusalCodeAbsentReason": "NOTHING_REFUSES",
                        "requiredAction": None,
                        "landing": {"workspaceId": None, "workspaceName": None}},
    }


def dump(directory):
    os.makedirs(directory, exist_ok=True)

    def put(name, body):
        with open(os.path.join(directory, name), "w") as fh:
            json.dump(body, fh, ensure_ascii=False, indent=1)
    put("projects.json", [summary(4)])
    put("sessions.json", [coordinator_session()])
    put("open-items.json", open_items())
    put("promotion.json", promotion())


# ── the writes ──────────────────────────────────────────────────────────────────────────────

def record(method, path, body):
    line = json.dumps({"at": datetime.now(timezone.utc).isoformat(), "method": method, "path": path,
                       "body": body}, ensure_ascii=False)
    with open(os.path.join(OUT, "writes.jsonl"), "a") as fh:
        fh.write(line + "\n")
    print(f"==> {method} {path} {json.dumps(body, ensure_ascii=False)}", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        try:
            with open(os.path.join(OUT, "requests.log"), "a") as fh:
                shape = type(body).__name__ + (f"[{len(body)}]" if isinstance(body, (list, dict)) else "")
                fh.write(f"{datetime.now(timezone.utc).strftime('%H:%M:%S')} {self.command} {self.path} -> {status} {shape}\n")
        except OSError:
            pass
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def _project_read(self, parts):
        pid = parts[2]
        if pid != PROJECT:
            return self._send({"message": "Project not found"}, 404)
        rest = "/".join(parts[3:])
        reads = {
            "": project_doc,
            "panorama": lambda: {"buckets": {"running": 0, "ready": 1, "blocked": 0,
                                             "awaitingVerification": 0, "done": 3, "failed": 0,
                                             "cancelled": 0, "integrating": 0, "onIntegrationLine": 0,
                                             "onUpstream": 3, "doneNotIntegrated": 0,
                                             "waitingForLanding": 0},
                                 "shape": {"taskCount": 4, "edgeCount": 0, "ratio": 0, "maxDepth": 0,
                                           "form": "flat"}},
            "panorama/ready": lambda: {"readyCount": 1, "queuedCount": 0, "runningCount": 0,
                                       "pausedCount": 0, "impactTruncated": None, "items": []},
            "integration": integration_view,
            "open-items": open_items,
            "coordinator/status": coordinator_status,
            "dependency-graph": lambda: {"marks": [], "edges": [], "taskCount": 0, "folded": False,
                                         "truncated": False,
                                         "limits": {"maxTasks": 500, "maxMarks": 300}},
            "tasks/page": lambda: {"items": [], "nextCursor": None},
            "acceptance/confirmation": lambda: {"state": "CONFIRMED", "confirmed": True,
                                                "currentVersion": {"digest": "c" * 64, "material": []},
                                                "confirmation": {"criteriaDigest": "c" * 64,
                                                                 "criteriaMaterial": [],
                                                                 "confirmedAt": iso(600),
                                                                 "confirmedById": WIKOVA}},
            "acceptance/criteria-decisions/pending": lambda: {"pending": [], "settled": []},
            "promotions/current": promotion,
            "promotions/merged": lambda: [],
        }
        if rest in reads:
            with LOCK:
                return self._send(reads[rest]())
        return self._send([])

    def do_GET(self):
        path = self.path.split("?")[0]
        parts = path.strip("/").split("/")
        if path.endswith("/api/events"):
            return self._sse()
        if path in ("/api/projects", "/api/projects/"):
            with LOCK:
                return self._send([summary(4)])
        if path == "/api/projects/sidebar":
            with LOCK:
                return self._send([summary(4)])
        if len(parts) >= 3 and parts[:2] == ["api", "projects"]:
            return self._project_read(parts)
        if path == "/api/sessions":
            with LOCK:
                return self._send([coordinator_session()])
        for sid in (COORD,):
            if path == f"/api/sessions/{sid}":
                with LOCK:
                    return self._send(coordinator_session())
            if path == f"/api/sessions/{sid}/events/page":
                return self._send(coordinator_events())
        routes = {
            "/api/users/me": {"id": WIKOVA, "email": "wikova@example.com", "name": "Wikova",
                              "role": "ADMIN", "createdAt": "2026-01-01T00:00:00.000Z"},
            "/api/agents": [AGENT],
            "/api/runners": [RUNNER],
            "/api/session-tags": [],
        }
        if path in routes:
            return self._send(routes[path])
        if path.startswith("/api/agents/"):
            return self._send(AGENT)
        if path.startswith("/api/runners/"):
            return self._send(RUNNER)
        return self._send([])

    def do_POST(self):
        path = self.path.split("?")[0]
        parts = path.strip("/").split("/")
        body = self._body()
        if path == "/api/__probe/reset":
            global STATE, T0
            with LOCK:
                T0 = datetime.now(timezone.utc)
                STATE = build()
            return self._send({"reset": True})
        if path == "/api/auth/login":
            return self._send({"accessToken": "probe-access-token", "refreshToken": "probe-refresh-token",
                               "user": {"id": WIKOVA, "email": body.get("email") or "wikova@example.com",
                                        "name": "Wikova", "role": "ADMIN"}})
        if len(parts) >= 4 and parts[:2] == ["api", "projects"] and parts[2] == PROJECT:
            pid, door = parts[2], "/".join(parts[3:])
            record("POST", path, body)
            with LOCK:
                if door == "coordinator":
                    return self._send({"sessionId": COORD, "created": False, "workspaceId": AGENT_ID}, 201)
                if door.startswith("open-items/") or door.endswith("/integration/retry"):
                    return self._send({"itemId": door.split("/")[1], "state": "RESOLVED",
                                       "resolution": "HANDLED", "generation": 2,
                                       "retryOfJobId": uid(730), "reason": body.get("reason", ""),
                                       "taskId": REPAIR_TASK, "sourceRef": f"project/{PROJECT}",
                                       "failureClass": "CHECK_FAILED", "handlingItemIds": []}, 201)
            return self._send({}, 201)
        if len(parts) >= 4 and parts[:2] == ["api", "sessions"]:
            record("POST", path, body)
        return self._send({})

    def do_PATCH(self):
        path = self.path.split("?")[0]
        body = self._body()
        if path.startswith("/api/sessions/") or path.startswith("/api/projects/"):
            record("PATCH", path, body)
        return self._send({})

    def do_PUT(self):
        self._body()
        self._send({})

    def do_DELETE(self):
        self._send({})

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                time.sleep(10)
        except Exception:
            return


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # http.server's own server_bind calls getfqdn(), which on macOS 26 raises the "allow Python to
    # find devices on your local network" prompt — over the very screenshots this is for.
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--dump":
        dump(sys.argv[2])
        sys.exit(0)
    print(f"stub control plane on 127.0.0.1:{PORT}, writing to {OUT}", flush=True)
    Server(("127.0.0.1", PORT), Handler).serve_forever()
