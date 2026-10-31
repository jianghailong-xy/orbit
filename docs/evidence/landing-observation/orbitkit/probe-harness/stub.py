#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged; see ../README.md): the slice of the Orbit API the native
# project pages, conversations and lists read, for one account whose projects stand in each of contract
# revision 29's states (§10.5 O-L1/O-L2, §10.7, §10.8, §10.9, §7.6 V12/V13):
#
#   P1  Payments gateway rollout  a main line whose agent pushes its own work (AGENT_PUSH): How it runs'
#                                 Delivery row, its tasks waiting to be seen on main, and its coordinator
#                                 conversation C1 — a LANDING_UNOBSERVED the coordinator handed over, with
#                                 the observation the owner asked for queued
#   P2  Refund service            a main line Orbit lands (PLATFORM); its coordinator conversation C2 holds
#                                 a LANDED_WITHOUT_CONFIRMATION, the oldest thing waiting on the owner
#   P3  Checkout redesign         a project branch, integrating: the agent's way drawn but not offered
#   P5  Ledger export             nobody started it; its coordinator (C5) asked to start on a main line
#   S7  a run of P1's task T5     its owner confirmation waiting, AGENT_PUSHED under If you confirm
#
# The writes answer the way the apiserver does and are recorded: `POST …/open-items/:id/accept`,
# `POST …/integration/observe` ({ reason }, which queues the observation the card then shows),
# `PATCH …/integration` and `POST …/start`. `POST /__reset` puts everything back; `GET /__log` is the
# request log with each written body as sorted JSON. Anything not served is a 404. All data is made up.
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
          "version": "0.1.230", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.312", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "payments-api", "provider": "claude", "lastProvider": "claude", "runnerId": "r1",
         "enabled": True, "enableWorktree": True, "effort": "", "workDir": "/srv/payments-api",
         "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}

REPOSITORY = "acme/payments-api"
LEDGER = "acme/ledger-api"
BRANCHES = {"names": ["develop", "main", "release/2.4"], "workspaceName": "payments-api", "reportedAt": ago(20)}
LEDGER_BRANCHES = {"names": ["develop", "main"], "workspaceName": "ledger-api", "reportedAt": ago(15)}
BRANCH = "project/34cfQ7mPaYmN2Wd8Rk3Jt"
TITLES = {"P1": "Payments gateway rollout", "P2": "Refund service", "P3": "Checkout redesign",
          "P5": "Ledger export"}
COORDINATOR = {"P1": "C1", "P2": "C2", "P3": "C3", "P5": "C5"}
DIGEST = "5d1a09c3be42" + "7" * 52
SHA = "9f1c2ab7e4d0b5a6c3f8e1d2a7b4c9e0f1a2b3c4"

CRITERIA = {
    "P1": ["Every payment goes through the new gateway behind a flag.",
           "A failed gateway call falls back to the old path within a second."],
    "P2": ["A refund can be issued from the support console in two clicks.",
           "Partial refunds keep the ledger balanced to the cent."],
    "P3": ["Checkout is one page on every supported browser."],
    "P5": ["Every ledger entry exports to CSV with its source document.",
           "An export of a month finishes within a minute."],
}

# The coordinator's request to start P5: directly into main, Automatic on.
START_REQUEST = {
    "itemId": "I5", "kind": "START_REQUEST", "title": "Start this project?", "detailLine": "",
    "waitingSince": ago(56), "assignee": "OWNER",
    "startRequest": {
        "settings": {"line": "MAIN", "upstreamRef": "refs/heads/main", "automatic": True,
                     "maxConcurrentTasks": 2, "mergeCheckCommand": "make test"},
        "why": "Two independent tasks, so each lands directly on main. The agent can push its own work "
               "there if you choose it under Delivery.",
        "criteriaDigest": DIGEST, "planDigest": "plan-p5", "repository": LEDGER, "warnings": []},
}


def unobserved():
    """§10.7: P1's finished task whose commit the observation did not find on main, handed to the owner
    by the coordinator; once the owner asks to look again, the observation is what handles it (§10.8)."""
    row = {
        "itemId": "U1", "kind": "LANDING_UNOBSERVED",
        "title": "Not on main yet: Ship the delivery mode picker",
        "detailLine": "Its commit was not found on the line · delivered 9f1c2ab7e4d0",
        "assignee": "OWNER", "assigneeReason": "HANDED_OVER",
        "waitingSince": ago(25), "escalateAt": None, "escalatedAt": ago(5),
        "taskId": "P1T1", "sessionId": "R1", "promotionId": None, "fuseEpisodeId": None,
        "delivery": {"state": "DELIVERED", "sessionId": "C1", "at": ago(24)},
        "actions": ["ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "OBSERVE", "CANCEL_TASK"],
        "requiredAction": "This task’s work is not on main yet — record the commit that carries it, or send "
                          "the task back to push it.",
        "primaryAction": "ASK_COORDINATOR_AGAIN", "question": None, "facts": None, "outcome": None,
        "handling": None,
    }
    observe = STATE["observe"]
    if observe:
        row["handling"] = {"sessionId": None, "userId": "u1", "reason": observe["reason"],
                           "startedAt": observe["at"], "jobId": "J9", "jobKind": "OBSERVE_LANDING",
                           "generation": 3, "state": "QUEUED"}
    return row


def landed():
    """§10.7: P2's work that reached main without the owner's confirmation — the owner's from birth."""
    return {
        "itemId": "L1", "kind": "LANDED_WITHOUT_CONFIRMATION",
        "title": "Reached main without your confirmation: Fix the login redirect",
        "detailLine": "7d3e9b01c2a4 is on main · seen by Orbit",
        "assignee": "OWNER", "assigneeReason": "DEFAULT",
        "waitingSince": ago(120), "escalateAt": None, "escalatedAt": None,
        "taskId": "P2T1", "sessionId": "R2", "promotionId": None, "fuseEpisodeId": None,
        "delivery": {"state": "NOT_REQUIRED", "sessionId": "C2", "at": None},
        "actions": ["ACCEPT", "OPEN_TASK_SESSION"],
        "requiredAction": "This work reached main without your confirmation — accept it, or use Chat about "
                          "this to have the coordinator file a task that reverts it.",
        "primaryAction": "ACCEPT", "question": None, "facts": None, "handling": None, "outcome": None,
    }


def transcript(lines):
    return [{"seq": i + 1, "type": typ, "ts": ago(minutes), "turnId": "t1", "payload": payload}
            for i, (typ, payload, minutes) in enumerate(lines)]


EVENTS = {
    "C1": transcript([
        ("user", {"text": "Keep the rollout moving; tell me what is stuck."}, 40),
        ("assistant", {"text": "The delivery mode picker finished, but its commit is not on main yet — the "
                               "agent's push did not arrive. I handed the item to you: the repository needs "
                               "your access to check what happened.", "messageId": "m1"}, 30),
        ("result", {"subtype": "success", "result": "done"}, 30),
    ]),
    "C2": transcript([
        ("user", {"text": "How is the refund service going?"}, 180),
        ("assistant", {"text": "All three tasks are done. One of them reached main before you confirmed it; "
                               "Orbit opened an item for you.", "messageId": "m2"}, 150),
        ("result", {"subtype": "success", "result": "done"}, 150),
    ]),
    "C5": transcript([
        ("user", {"text": "Plan the ledger export and ask me to start it."}, 70),
        ("assistant", {"text": "Two independent tasks, so each lands directly on main. Asking you to start.",
                       "messageId": "m5"}, 57),
        ("result", {"subtype": "success", "result": "done"}, 57),
    ]),
    "S7": transcript([
        ("user", {"text": "Publish the release notes for the gateway rollout."}, 30),
        ("assistant", {"text": "The release notes are written and pushed to main on the task branch's commit. "
                               "Waiting for you to confirm the task is done.", "messageId": "m7"}, 12),
        ("result", {"subtype": "success", "result": "done"}, 12),
    ]),
}


def session(sid):
    base = {"id": sid, "status": "AWAITING_INPUT", "runStatus": "AWAITING_INPUT", "runState": "AWAITING_INPUT",
            "lifecycleState": "OPEN", "agentId": "a1", "agent": {"id": "a1", "name": "payments-api"},
            "assignedRunnerId": "r1", "provider": "claude", "model": "claude-opus-5-5", "effort": "max",
            "permissionMode": "default", "taskId": None, "createdAt": ago(DAY), "tags": [], "folderId": None,
            "source": "USER", "pendingApprovals": 0, "engineTurnActive": False}
    events = EVENTS[sid]
    base.update(updatedAt=events[-1]["ts"], lastTurnAt=events[-1]["ts"],
                lastAssistantText=events[1]["payload"]["text"])
    if sid == "C1":
        base.update(title="Coordinate Payments gateway rollout", projectId="P1",
                    projectTitle=TITLES["P1"], pendingApprovals=1, waitingKind="OWNER_ITEM",
                    ownerItems=[{"itemId": "U1", "kind": "ESCALATED",
                                 "title": "Not on main yet: Ship the delivery mode picker",
                                 "since": ago(5), "need": "Not on the line yet", "mainBranch": "main"}])
    elif sid == "C2":
        base.update(title="Coordinate Refund service", projectId="P2", projectTitle=TITLES["P2"],
                    pendingApprovals=1, waitingKind="OWNER_ITEM",
                    ownerItems=[] if STATE["accepted"] else
                    [{"itemId": "L1", "kind": "LANDED_WITHOUT_CONFIRMATION",
                      "title": "Reached main without your confirmation: Fix the login redirect",
                      "since": ago(120), "need": "Landed without your confirmation", "mainBranch": "main"}])
        if STATE["accepted"]:
            base.update(pendingApprovals=0, waitingKind=None)
    elif sid == "C5":
        base.update(title="Coordinate Ledger export", projectId="P5", projectTitle=TITLES["P5"],
                    pendingApprovals=1, waitingKind="START_REQUEST")
    else:
        base.update(title="Publish the release notes", taskId="T5",
                    projectMembership={"projectId": "P1", "projectTitle": TITLES["P1"], "projectStatus": "OPEN",
                                       "role": "TASK"},
                    waitingKind="OWNER_CONFIRMATION")
    return base


def owner_confirmation():
    """S7's task (T5, OWNER_CONFIRMED) in an AGENT_PUSH project: confirming merges nothing (§10.5 O-L2)."""
    return {
        "taskId": "T5", "title": "Publish the release notes", "status": "OPEN", "projectId": "P1",
        "completionCriterion": "OWNER_CONFIRMED",
        "acceptanceCriteria": "The release notes are on the docs site and linked from the changelog.",
        "waiting": {"requestId": "Q7", "sessionId": "S7", "requestedAt": ago(12),
                    "report": {"text": "Release notes written and pushed to main; the changelog links them.",
                               "reportedAt": ago(12)}},
        "decisions": [], "reviewerReturns": [],
        "ifConfirmed": {"startsTasks": [{"id": "P1T4", "title": "Rollout runbook", "starts": "NOW"}],
                        "startsAfterLanding": False,
                        "branch": {"name": "orbit/task-release-notes-7c1d2e", "linesAdded": 1240,
                                   "linesRemoved": 38, "files": 9, "onMain": "NO"},
                        "landing": "AGENT_PUSHED", "mainBranch": "main"},
    }


STATE = {}


def reset():
    STATE.clear()
    STATE.update(projects={
        "P1": dict(started=ago(3 * DAY), line="MAIN", ref="main", upstreamRef="main", chosenAt=ago(3 * DAY),
                   repository=REPOSITORY, branches=BRANCHES, locked=False, integratingSince=None,
                   check="make test", automatic=True, delivery="AGENT_PUSH", tasks=5),
        "P2": dict(started=ago(5 * DAY), line="MAIN", ref="main", upstreamRef="main", chosenAt=ago(5 * DAY),
                   repository=REPOSITORY, branches=BRANCHES, locked=True, integratingSince=ago(4 * DAY),
                   check="make test", automatic=True, delivery="PLATFORM", tasks=3),
        "P3": dict(started=ago(5 * DAY), line="PROJECT_BRANCH", ref=BRANCH, upstreamRef="main",
                   chosenAt=ago(5 * DAY), repository=REPOSITORY, branches=BRANCHES, locked=True,
                   integratingSince=ago(3 * DAY), check="make test", automatic=True, delivery="PLATFORM", tasks=4),
        "P5": dict(started=None, line=None, ref=None, upstreamRef="main", chosenAt=None,
                   repository=LEDGER, branches=LEDGER_BRANCHES, locked=False, integratingSince=None,
                   check="make test", automatic=True, delivery="PLATFORM", tasks=2),
    }, observe=None, accepted=False, writes=[])


reset()


def criterion(pid, ordinal, text):
    cid = "%sC%d" % (pid, ordinal)
    return {"id": cid, "publicId": cid, "key": cid, "ordinal": ordinal, "text": text, "satisfied": False,
            "unmet": [], "landing": "UNKNOWN", "verificationMethod": "A spec and a screenshot."}


def settings_half(pid):
    p = STATE["projects"][pid]
    return {"line": p["line"], "lineAbsentReason": None if p["line"] else "NOT_DECIDED", "ref": p["ref"],
            "upstreamRef": p["upstreamRef"], "upstreamChosenAt": p["chosenAt"], "lastMainBranch": None,
            "source": "EXPLICIT" if p["line"] else None, "locked": p["locked"], "startedAt": p["integratingSince"],
            "mergeCheckCommand": p["check"], "mergeCheckCommandAbsentReason": None if p["check"] else "NOT_CONFIGURED",
            "mergeCheckTimeoutSeconds": None, "escalationSeconds": 7200,
            "deliveryMode": p["delivery"], "deliveryModeChosenAt": ago(2 * DAY) if p["delivery"] == "AGENT_PUSH" else None}


def integration(pid):
    p = STATE["projects"][pid]
    view = settings_half(pid)
    view.update({"repository": p["repository"], "branches": p["branches"],
                 "commitsAheadOfUpstream": 3 if p["line"] == "PROJECT_BRANCH" else None,
                 "commitsAheadOfUpstreamAbsentReason": None if p["line"] == "PROJECT_BRANCH" else "NO_LANDING_YET",
                 "lastUpstreamSyncAt": ago(120) if p["line"] == "PROJECT_BRANCH" else None,
                 "lastUpstreamSyncAbsentReason": None if p["line"] == "PROJECT_BRANCH" else "NEVER_SYNCED",
                 "integratingCount": 0, "queuedCount": 1 if (pid == "P1" and STATE["observe"]) else 0,
                 "mergeCheckOnTip": "UNKNOWN", "inFlight": None, "inFlightJobs": [], "landTasks": []})
    return view


def document(pid):
    p = STATE["projects"][pid]
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": "OPEN",
            "goal": "Probe goal for %s." % TITLES[pid], "instructions": "Probe instructions.",
            "createdAt": ago(20 * DAY), "updatedAt": ago(30), "coordinatorEnabled": p["automatic"],
            "configRevision": "1", "coordinatorSessionId": COORDINATOR[pid],
            "_count": {"tasks": p["tasks"]}, "tasksByStatus": {"OPEN": p["tasks"]},
            "acceptanceCriteriaItems": [criterion(pid, i + 1, t) for i, t in enumerate(CRITERIA[pid])],
            "blockers": {"open": [], "resolved": [], "resolvedCount": 0},
            "integration": settings_half(pid), "startedAt": p["started"], "pausedAt": None,
            "maxConcurrentTasks": 2, "exceptionEscalationSeconds": 7200}


def summary(pid):
    p = STATE["projects"][pid]
    attention = {"userBlockers": 0, "coordinatorBlockers": 0, "systemBlockers": 0, "ownerItems": []}
    if pid == "P1":
        attention["ownerItems"] = [{"kind": "ESCALATED", "count": 1, "oldestWaitingSince": ago(5)}]
    if pid == "P2" and not STATE["accepted"]:
        attention["ownerItems"] = [{"kind": "LANDED_WITHOUT_CONFIRMATION", "count": 1,
                                    "oldestWaitingSince": ago(120)}]
    if pid == "P5":
        attention["startRequest"] = {"waitingSince": ago(56)}
    buckets = {"P1": dict(running=0, ready=0, blocked=1, done=4, failed=0, cancelled=0, integrating=2,
                          onIntegrationLine=0, onUpstream=2, doneNotIntegrated=0),
               "P2": dict(running=0, ready=0, blocked=0, done=3, failed=0, cancelled=0),
               "P3": dict(running=1, ready=1, blocked=1, done=1, failed=0, cancelled=0),
               "P5": dict(running=0, ready=2, blocked=0, done=0, failed=0, cancelled=0)}[pid]
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": "OPEN",
            "goal": "Probe goal for %s." % TITLES[pid], "createdAt": ago(20 * DAY), "updatedAt": ago(30),
            "lastActivityAt": ago(30), "_count": {"tasks": p["tasks"]}, "startedAt": p["started"],
            "buckets": buckets, "attention": attention,
            "integration": {"line": p["line"], "ref": p["ref"], "activeJobCount": 0} if p["line"] else None,
            "taskCounts": {"done": buckets["done"], "failed": 0, "total": p["tasks"]},
            "mainBranch": p["upstreamRef"]}


def task_row(pid, n, title, status="DONE", integration=None, **extra):
    row = {"id": "%sT%d" % (pid, n), "publicId": "%sT%d" % (pid, n), "title": title, "status": status,
           "parentTaskId": None, "childCount": 0, "unmetCount": 0, "blocksCount": 0, "topoLevel": 0,
           "dependencyState": "READY", "workState": "DONE" if status == "DONE" else "READY",
           "completionPolicy": "MANUAL", "autoRunWhenReady": True, "integration": integration}
    row.update(extra)
    return row


def tasks(pid):
    if pid != "P1":
        return [task_row(pid, i + 1, "Task %d" % (i + 1), status="OPEN") for i in range(STATE["projects"][pid]["tasks"])]
    waiting = lambda sha: {"state": "AWAITING_OBSERVATION", "since": ago(40), "handler": None, "openItemId": None,
                           "jobId": None, "checksRunningForMs": None, "landTask": None, "mainBranch": "main",
                           "deliveredSha": sha}
    seen = {"state": "ON_UPSTREAM", "since": ago(90), "handler": None, "openItemId": None, "jobId": None,
            "checksRunningForMs": None, "landTask": None, "mainBranch": "main"}
    return [
        task_row("P1", 1, "Ship the delivery mode picker", integration=waiting(SHA)),
        task_row("P1", 2, "Retry the export on a timeout", integration=waiting(None)),
        task_row("P1", 3, "Fix the login redirect", integration=seen),
        task_row("P1", 6, "Gateway client behind a flag", integration=seen),
        task_row("P1", 4, "Rollout runbook", status="OPEN", workState="BLOCKED", dependencyState="BLOCKED",
                 unmetCount=0, topoLevel=1, landingWaitCount=2),
    ]


def open_items(pid):
    items = {"needsYou": [], "withCoordinator": [], "mainBranch": STATE["projects"][pid]["upstreamRef"]}
    if pid == "P1":
        items["needsYou"] = [unobserved()]
    if pid == "P2" and not STATE["accepted"]:
        items["needsYou"] = [landed()]
    if pid == "P5" and not STATE["projects"]["P5"]["started"]:
        items["startRequest"] = START_REQUEST
    return items


def confirmation(pid):
    material = [{"definitionId": "%sC%d" % (pid, i + 1), "revision": 1, "contentHash": "h%d" % i}
                for i in range(len(CRITERIA[pid]))]
    return {"state": "CONFIRMED" if STATE["projects"][pid]["started"] else "UNCONFIRMED",
            "confirmed": bool(STATE["projects"][pid]["started"]),
            "currentVersion": {"digest": DIGEST, "material": material}, "confirmation": None}


def graph(pid):
    rows = tasks(pid)
    marks = [{"kind": "TASK", "id": t["id"], "taskId": t["id"], "title": t["title"], "status": t["status"],
              "completionCriterion": "EVIDENCE_JUDGMENT", "autoRunWhenReady": True} for t in rows]
    return {"marks": marks, "edges": [], "taskCount": len(rows), "truncated": False}


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
            return self.stream([])
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
            query = parsed.query
            if "view=open" in query or query == "" or "agentId" in query and "view=" not in query:
                return self.send(200, [session(s) for s in ("C2", "C1", "C5", "S7")])
            return self.send(200, [])
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"] and parts[2] in EVENTS:
            sid, rest = parts[2], parts[3:]
            if rest == []:
                return self.send(200, session(sid))
            if rest == ["events"]:
                return self.stream(EVENTS[sid])
            if rest == ["events", "page"]:
                return self.send(200, {"events": EVENTS[sid], "hasMore": False, "before": None, "after": None})
            if rest in (["approvals"], ["turns"]):
                return self.send(200, [])
        if parts == ["api", "tasks", "T5", "owner-confirmation"]:
            return self.send(200, owner_confirmation())
        if parts in (["api", "providers"], ["api", "providers", "mine"], ["api", "providers", "pools"],
                     ["api", "providers", "shared-pools"], ["api", "session-tags"], ["api", "session-folders"],
                     ["api", "task-lists"], ["api", "watches"]):
            return self.send(200, [])
        if parts in (["api", "projects"], ["api", "projects", "sidebar"]):
            return self.send(200, [summary(pid) for pid in ("P1", "P2", "P3", "P5")])
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
                return self.send(200, open_items(pid))
            if rest == ["acceptance", "confirmation"]:
                return self.send(200, confirmation(pid))
            if rest == ["dependency-graph"]:
                return self.send(200, graph(pid))
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def stream(self, events):
        """A session's events as SSE `data:` frames (the server's own framing), then keepalives inside
        the clients' 45 s watchdog. Nothing new ever arrives."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for e in events:
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
        raw, body = self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        self.note("BODY %s %s" % (self.path, json.dumps(body, sort_keys=True, ensure_ascii=False)))
        if parts == ["api", "projects", "P2", "open-items", "L1", "accept"]:
            STATE["accepted"] = True
            return self.send(200, {"itemId": "L1", "state": "RESOLVED", "resolution": "ACCEPTED"})
        if parts == ["api", "projects", "P1", "integration", "observe"]:
            reason = (body.get("reason") or "").strip()
            if not reason:
                return self.send(400, {"statusCode": 400, "code": "INTEGRATION_OBSERVE_REASON_REQUIRED",
                                       "message": "say why the line should be looked at again"})
            STATE["observe"] = {"reason": reason, "at": ago(0)}
            return self.send(201, {"jobId": "J9", "generation": 3, "state": "QUEUED", "joined": False})
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
        if p["locked"] and "line" in body:
            return self.send(409, {"statusCode": 409, "code": "INTEGRATION_LINE_LOCKED",
                                   "message": "this project started integrating, so its line can no longer change"})
        line = body.get("line", p["line"])
        if body.get("deliveryMode") == "AGENT_PUSH" and line != "MAIN":
            return self.send(409, {"statusCode": 409, "code": "DELIVERY_MODE_NEEDS_MAIN_LINE",
                                   "message": "the agent can push only on a project that lands directly into main"})
        if "line" in body:
            p["line"] = body["line"]
        if "deliveryMode" in body:
            p["delivery"] = body["deliveryMode"]
        return self.send(200, integration(pid))

    def start(self, pid, body):
        p = STATE["projects"][pid]
        if p["started"]:
            return self.send(409, {"statusCode": 409, "code": "PROJECT_ALREADY_STARTED", "message": "already started"})
        if body.get("deliveryMode") == "AGENT_PUSH" and body.get("line") != "MAIN":
            return self.send(409, {"statusCode": 409, "code": "DELIVERY_MODE_NEEDS_MAIN_LINE",
                                   "message": "the agent can push only on a project that lands directly into main"})
        p["started"] = ago(0)
        p["line"] = body.get("line")
        p["ref"] = BRANCH if body.get("line") == "PROJECT_BRANCH" else "main"
        p["automatic"] = body.get("automatic", True)
        if body.get("deliveryMode"):
            p["delivery"] = body["deliveryMode"]
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
