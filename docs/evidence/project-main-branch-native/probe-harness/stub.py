#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged; see README.md): the slice of the Orbit API the native project
# page and its Start… sheet read, for four projects of one account whose repository acme/payments-api
# has the branches develop / master / release/2.4 (docs/mocks/project-main-branch/02-ios.png):
#
#   P1  Payments gateway rollout  started, nothing integrated yet: How it runs can still move its main
#                                 branch (master, the owner's choice two days ago)
#   P2  Refund service            nobody started it, nobody asked: the owner's own Start… opens on the
#                                 owner's last choice for the repository (master)
#   P3  Checkout redesign         started integrating 3 days ago: the line and its main branch locked
#   P4  Docs site                 nobody started it, and it has no repository: no Main branch row
#   P5  Ledger export             nobody started it; its coordinator (conversation C5) asked to start and,
#                                 this account never having chosen for acme/ledger-api, suggested master
#
# The two doors answer the way the apiserver does for these cases and record what they were sent:
# `PATCH /api/projects/:id/integration` moves an unlocked project's main branch (refused 409
# INTEGRATION_LINE_LOCKED once locked) and answers the integration read again; `POST
# /api/projects/:id/start` starts the project on the settings it is sent, main branch included.
# `POST /__reset` puts everything back; `GET /__log` is the request log, each written body as JSON with
# sorted keys (Swift escapes "/" as "\/" on the wire; the log says what was decoded). Anything not
# served is a 404. All data is made up.
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
USER = {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "hpc", "displayName": "hpc", "online": True, "status": "ONLINE",
          "version": "0.1.219", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "payments-api", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/payments-api",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}

REPOSITORY = "acme/payments-api"
LEDGER = "acme/ledger-api"
LEDGER_BRANCHES = {"names": ["develop", "master", "release/1.0"], "workspaceName": "ledger-api",
                   "reportedAt": ago(15)}
BRANCHES = {"names": ["develop", "master", "release/2.4"], "workspaceName": "payments-api",
            "reportedAt": ago(20)}
LAST = {"branch": "master", "repository": REPOSITORY, "chosenAt": ago(2 * DAY)}
BRANCH = "project/34cfQ7mPaYmN2Wd8Rk3Jt"
TITLES = {"P1": "Payments gateway rollout", "P2": "Refund service", "P3": "Checkout redesign",
          "P4": "Docs site", "P5": "Ledger export"}
DIGEST = "5d1a09c3be42" + "7" * 52

CRITERIA = {
    "P1": ["Every payment goes through the new gateway behind a flag.",
           "A failed gateway call falls back to the old path within a second.",
           "Refunds and chargebacks reconcile nightly with zero drift."],
    "P2": ["A refund can be issued from the support console in two clicks.",
           "Partial refunds keep the ledger balanced to the cent."],
    "P3": ["Checkout is one page on every supported browser.",
           "Card errors say what to fix in plain words."],
    "P4": ["Every public endpoint has a page with a runnable example."],
    "P5": ["Every ledger entry exports to CSV with its source document.",
           "An export of a month finishes within a minute.",
           "Exports reconcile with the general ledger to the cent."],
}

# The coordinator's request to start P5 (`project_request_start`): a project branch, Automatic on, and
# the main branch it read off the repository's origin/HEAD — a suggestion, the account having no
# choice of its own for acme/ledger-api.
START_REQUEST = {
    "itemId": "I5", "kind": "START_REQUEST", "title": "Start this project?", "detailLine": "",
    "waitingSince": ago(56), "assignee": "OWNER",
    "startRequest": {
        "settings": {"line": "PROJECT_BRANCH", "upstreamRef": "refs/heads/master", "automatic": True,
                     "maxConcurrentTasks": 2, "mergeCheckCommand": "make test"},
        "why": "The plan is three tasks that build on each other, so they land on a project branch and are "
               "checked together. The repository's main branch is master (origin/HEAD), so the branch merges "
               "into master once the merge check passes.",
        "criteriaDigest": DIGEST, "planDigest": "plan-p5", "repository": LEDGER, "warnings": []},
}

C5_EVENTS = [
    ("user", {"text": "Plan the ledger export and ask me to start it."}, 70),
    ("assistant", {"text": "The repository's main branch is master — origin/HEAD says so — and the plan is three "
                           "tasks that build on each other. It passed the ready check; asking you to start.",
                   "messageId": "m1"}, 57),
    ("result", {"subtype": "success", "result": "done"}, 57),
]


def c5_events():
    return [{"seq": i + 1, "type": typ, "ts": ago(minutes), "turnId": "t1", "payload": payload}
            for i, (typ, payload, minutes) in enumerate(C5_EVENTS)]


def c5_session():
    return {"id": "C5", "title": "Coordinate Ledger export", "status": "AWAITING_INPUT",
            "runStatus": "AWAITING_INPUT", "runState": "AWAITING_INPUT", "lifecycleState": "OPEN", "agentId": "a1",
            "agent": {"id": "a1", "name": "a1"}, "assignedRunnerId": "r1", "provider": "claude",
            "model": "claude-opus-5-5", "effort": "max", "permissionMode": "default", "taskId": None,
            "projectId": "P5", "createdAt": ago(80), "updatedAt": ago(56), "lastTurnAt": ago(57),
            "lastAssistantText": C5_EVENTS[1][1]["text"], "pendingApprovals": 1, "waitingKind": "START_REQUEST",
            "tags": [], "folderId": None, "source": "USER"}

STATE = {}


def reset():
    STATE.clear()
    STATE.update(projects={
        # Started; nothing has integrated, so How it runs can still move the main branch.
        "P1": dict(started=ago(3 * DAY), line="PROJECT_BRANCH", ref=BRANCH, upstreamRef="master",
                   chosenAt=ago(2 * DAY), last=LAST, repository=REPOSITORY, branches=BRANCHES, locked=False,
                   integratingSince=None, ahead=None, synced=None, check="make test", automatic=True, tasks=4),
        # Nobody started it or asked: the owner's own Start…, on the last choice for the repository.
        "P2": dict(started=None, line=None, ref=None, upstreamRef=None, chosenAt=None, last=LAST,
                   repository=REPOSITORY, branches=BRANCHES, locked=False, integratingSince=None, ahead=None,
                   synced=None, check="make test", automatic=True, tasks=3),
        # Integrating for three days: the line and its main branch locked together.
        "P3": dict(started=ago(5 * DAY), line="PROJECT_BRANCH", ref=BRANCH, upstreamRef="master",
                   chosenAt=ago(5 * DAY), last=LAST, repository=REPOSITORY, branches=BRANCHES, locked=True,
                   integratingSince=ago(3 * DAY), ahead=3, synced=ago(120), check="make test", automatic=True,
                   tasks=4),
        # No repository: no branch to name.
        "P4": dict(started=None, line=None, ref=None, upstreamRef=None, chosenAt=None, last=None,
                   repository=None, branches=None, locked=False, integratingSince=None, ahead=None, synced=None,
                   check=None, automatic=True, tasks=2),
        # Its coordinator asked; this account never chose a main branch for its repository.
        "P5": dict(started=None, line=None, ref=None, upstreamRef=None, chosenAt=None, last=None,
                   repository=LEDGER, branches=LEDGER_BRANCHES, locked=False, integratingSince=None, ahead=None,
                   synced=None, check="make test", automatic=True, tasks=3),
    }, writes=[])


reset()


def criterion(pid, ordinal, text):
    cid = "%sC%d" % (pid, ordinal)
    return {"id": cid, "publicId": cid, "key": cid, "ordinal": ordinal, "text": text, "satisfied": False,
            "unmet": [], "landing": "UNKNOWN", "verificationMethod": "A spec and a screenshot."}


def settings_half(pid):
    p = STATE["projects"][pid]
    return {"line": p["line"], "lineAbsentReason": None if p["line"] else "NOT_DECIDED", "ref": p["ref"],
            "upstreamRef": p["upstreamRef"], "upstreamChosenAt": p["chosenAt"], "lastMainBranch": p["last"],
            "source": "EXPLICIT" if p["line"] else None, "locked": p["locked"], "startedAt": p["integratingSince"],
            "mergeCheckCommand": p["check"], "mergeCheckCommandAbsentReason": None if p["check"] else "NOT_CONFIGURED",
            "mergeCheckTimeoutSeconds": None, "escalationSeconds": 7200}


def integration(pid):
    p = STATE["projects"][pid]
    view = settings_half(pid)
    view.update({"repository": p["repository"], "branches": p["branches"],
                 "commitsAheadOfUpstream": p["ahead"],
                 "commitsAheadOfUpstreamAbsentReason": None if p["ahead"] is not None else "NO_LANDING_YET",
                 "lastUpstreamSyncAt": p["synced"], "lastUpstreamSyncAbsentReason": None if p["synced"] else "NEVER_SYNCED",
                 "integratingCount": 0, "queuedCount": 0, "mergeCheckOnTip": "PASSING" if p["ahead"] else "UNKNOWN",
                 "inFlight": None, "inFlightJobs": [], "landTasks": []})
    return view


def document(pid):
    p = STATE["projects"][pid]
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": "OPEN",
            "goal": "Probe goal for %s." % TITLES[pid], "instructions": "Probe instructions.",
            "createdAt": ago(20 * DAY), "updatedAt": ago(30), "coordinatorEnabled": p["automatic"],
            "configRevision": "1", "coordinatorSessionId": "C5" if pid == "P5" else "S-%s" % pid,
            "_count": {"tasks": p["tasks"]},
            "tasksByStatus": {"OPEN": p["tasks"]},
            "acceptanceCriteriaItems": [criterion(pid, i + 1, t) for i, t in enumerate(CRITERIA[pid])],
            "blockers": {"open": [], "resolved": [], "resolvedCount": 0},
            "integration": settings_half(pid), "startedAt": p["started"], "pausedAt": None,
            "maxConcurrentTasks": 2, "exceptionEscalationSeconds": 7200}


def summary(pid):
    p = STATE["projects"][pid]
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": "OPEN",
            "goal": "Probe goal for %s." % TITLES[pid], "createdAt": ago(20 * DAY), "updatedAt": ago(30),
            "lastActivityAt": ago(30), "_count": {"tasks": p["tasks"]}, "startedAt": p["started"],
            "taskCounts": {"done": 0, "failed": 0, "total": p["tasks"]},
            "mainBranch": p["upstreamRef"]}


def tasks(pid):
    names = ["Gateway client behind a flag", "Fallback to the old path", "Nightly reconciliation",
             "Rollout runbook"][: STATE["projects"][pid]["tasks"]]
    return [{"id": "%sT%d" % (pid, i + 1), "publicId": "%sT%d" % (pid, i + 1), "title": title, "status": "OPEN",
             "parentTaskId": None, "childCount": 0, "unmetCount": 0, "blocksCount": 0, "topoLevel": i,
             "dependencyState": "READY", "workState": "IDLE", "completionPolicy": "MANUAL",
             "autoRunWhenReady": True} for i, title in enumerate(names)]


def graph(pid):
    """The plan as a chain — each task waits on the one before — so the owner's own Start… opens on a
    project branch by the default rule, as the board's cards do."""
    rows = tasks(pid)
    marks = [{"kind": "TASK", "id": t["id"], "taskId": t["id"], "title": t["title"], "status": "OPEN",
              "completionCriterion": "OWNER_CONFIRMED" if i == len(rows) - 1 else "EVIDENCE_JUDGMENT",
              "autoRunWhenReady": True} for i, t in enumerate(rows)]
    edges = [{"sourceMarkId": rows[i]["id"], "targetMarkId": rows[i + 1]["id"]} for i in range(len(rows) - 1)]
    return {"marks": marks, "edges": edges, "taskCount": len(rows), "truncated": False}


def confirmation(pid):
    material = [{"definitionId": "%sC%d" % (pid, i + 1), "revision": 1, "contentHash": "h%d" % i}
                for i in range(len(CRITERIA[pid]))]
    return {"state": "UNCONFIRMED", "confirmed": False, "currentVersion": {"digest": DIGEST, "material": material},
            "confirmation": None}


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
        if parts == ["api", "sessions"]:
            return self.send(200, [c5_session()] if "view=open" in self.path or "?" not in self.path else [])
        if len(parts) == 4 and parts[:3] == ["api", "sessions", "C5"] and parts[3] == "events":
            return self.events_stream()
        if len(parts) >= 3 and parts[:3] == ["api", "sessions", "C5"]:
            rest = parts[3:]
            if rest == []:
                return self.send(200, c5_session())
            if rest == ["events", "page"]:
                return self.send(200, {"events": c5_events(), "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
        if parts in (["api", "providers"], ["api", "providers", "mine"],
                     ["api", "providers", "pools"], ["api", "providers", "shared-pools"], ["api", "session-tags"],
                     ["api", "session-folders"], ["api", "task-lists"], ["api", "watches"]):
            return self.send(200, [])
        if parts in (["api", "projects"], ["api", "projects", "sidebar"]):
            return self.send(200, [summary(pid) for pid in ("P1", "P2", "P3", "P4", "P5")])
        if len(parts) >= 3 and parts[:2] == ["api", "projects"] and parts[2] in TITLES:
            pid, rest = parts[2], parts[3:]
            if rest == []:
                return self.send(200, document(pid))
            if rest == ["integration"]:
                return self.send(200, integration(pid))
            if rest == ["tasks", "page"]:
                return self.send(200, {"items": tasks(pid), "nextCursor": None})
            if rest == ["handoffs"]:
                return self.send(200, [])
            if rest == ["open-items"]:
                items = {"needsYou": [], "withCoordinator": [], "mainBranch": STATE["projects"][pid]["upstreamRef"]}
                if pid == "P5" and not STATE["projects"]["P5"]["started"]:
                    items["startRequest"] = START_REQUEST
                return self.send(200, items)
            if rest == ["acceptance", "confirmation"]:
                return self.send(200, confirmation(pid))
            if rest == ["dependency-graph"]:
                return self.send(200, graph(pid))
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def events_stream(self):
        """C5's events (SSE `data:` frames, the server's own framing), then keepalives inside the clients'
        45 s watchdog. Nothing new ever arrives."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for e in c5_events():
                self.wfile.write(("data: %s\n\n" % json.dumps(e, ensure_ascii=False)).encode())
            self.wfile.flush()
            while True:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                time.sleep(10)
        except (BrokenPipeError, ConnectionResetError):
            return

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
        self.note("BODY %s %s" % (self.path, json.dumps(body, sort_keys=True, ensure_ascii=False)))
        if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[2] in TITLES and parts[3] == "start":
            return self.start(parts[2], body)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def do_PATCH(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        raw, body = self.body()
        self.note("BODY %s %s" % (self.path, json.dumps(body, sort_keys=True, ensure_ascii=False)))
        if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[2] in TITLES and parts[3] == "integration":
            return self.configure(parts[2], body)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def configure(self, pid, body):
        p = STATE["projects"][pid]
        STATE["writes"].append({"door": "integration", "projectId": pid, "body": body})
        if p["locked"] and ("line" in body or "upstreamRef" in body):
            return self.send(409, {"statusCode": 409, "code": "INTEGRATION_LINE_LOCKED",
                                   "message": "this project started integrating, so its line and main branch can no longer change"})
        if "upstreamRef" in body:
            if not p["repository"]:
                return self.send(400, {"statusCode": 400, "message": "this project has no repository to name a main branch of"})
            p["upstreamRef"] = body["upstreamRef"].replace("refs/heads/", "", 1)
            p["chosenAt"] = ago(0)
            p["last"] = {"branch": p["upstreamRef"], "repository": p["repository"], "chosenAt": ago(0)}
        if "line" in body:
            p["line"] = body["line"]
        if "mergeCheckCommand" in body:
            p["check"] = body["mergeCheckCommand"]
        return self.send(200, integration(pid))

    def start(self, pid, body):
        p = STATE["projects"][pid]
        STATE["writes"].append({"door": "start", "projectId": pid, "body": body})
        if p["started"]:
            return self.send(409, {"statusCode": 409, "code": "PROJECT_ALREADY_STARTED", "message": "already started"})
        if body.get("upstreamRef") and not p["repository"]:
            return self.send(400, {"statusCode": 400, "message": "this project has no repository to name a main branch of"})
        p["started"] = ago(0)
        p["line"] = body.get("line")
        p["ref"] = BRANCH if body.get("line") == "PROJECT_BRANCH" else None
        p["automatic"] = body.get("automatic", True)
        p["check"] = body.get("mergeCheckCommand")
        if body.get("upstreamRef"):
            p["upstreamRef"] = body["upstreamRef"].replace("refs/heads/", "", 1)
            p["chosenAt"] = ago(0)
            p["last"] = {"branch": p["upstreamRef"], "repository": p["repository"], "chosenAt": ago(0)}
        settings = {k: body[k] for k in ("line", "projectBranchName", "upstreamRef", "automatic",
                                         "maxConcurrentTasks", "mergeCheckCommand") if k in body}
        return self.send(201, {"settings": settings, "differsFromRequest": [], "coordinator": None,
                               "projectId": pid, "startedAt": p["started"], "criteriaDigest": body.get("criteriaDigest"),
                               "criteriaCount": len(CRITERIA[pid])})

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
