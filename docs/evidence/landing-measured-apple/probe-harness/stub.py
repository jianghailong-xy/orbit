#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged; see README.md): the slice of the Orbit API the iPhone app reads
# for the five screens of docs/mocks/landing-measured (contract revision 42 part two), all for one
# example project, "Rotate staging credentials", as the board draws it:
#
#   C5 / P5  ① the coordinator asks to start with NO line: the start card draws one sentence
#            ("Lands on the project's branch when a task commits") and Start sends no `line`
#   P1       ② started, no line yet (integration.line null): the sessions page draws no landing card,
#            no Landings row
#   P2       ③ How it runs' landing check: a command the coordinator set 12m ago, the three values,
#            and Coordinator's changes; pressing No check writes `landingCheck: NONE` as the owner's
#   P3, T1   ⑤ Coordinator's changes: a cardless No check, a task exemption, the owner's own command;
#            Revert asks first, then `POST …/setting-changes/c1/revert` puts the command back
#   T1, L1   ④ the task exempt from the landing check, on its page (Remove exemption writes
#            `landingCheckExempt: false`) and in its landing's check list (Skipped, TASK_EXEMPT)
#   T2       ④ an exempt task with no landing yet, its exemption approved on a card (record c4)
#
# `POST /__reset` puts everything back; `GET /__log` is the request log with each written body as JSON
# (sorted keys). Anything not served is a 404 and is logged. All data is made up.
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


DAY = 24 * 60
TITLE = "Rotate staging credentials"
PIDS = ("P1", "P2", "P3", "P5")
BRANCH = "project/35Qa7mXk"
USER = {"id": "u1", "email": "owner@example.com", "name": "Owner", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "orbit-develop", "displayName": "orbit-develop", "online": True,
          "status": "ONLINE", "version": "0.1.260", "maxConcurrent": 4, "lastHeartbeatAt": ago(0),
          "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "orbit-develop", "provider": "claude", "lastProvider": "claude",
         "runnerId": "r1", "enabled": True, "enableWorktree": True, "effort": "",
         "workDir": "/srv/infra", "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}
DIGEST = "5d1a09c3be42" + "7" * 52
CRITERIA = ["Staging DB password is rotated and every service reads the new one.",
            "The old password is revoked and no login uses it for 24 hours.",
            "The rotation runbook says how to do it again in under ten minutes."]
TASKS = ["Rotate the staging database password", "Move cron jobs off the old VM",
         "Delete unused staging buckets", "Restart the staging services",
         "Revoke the old password", "Write the rotation runbook"]
EXEMPT_REASON = "Only moves cron entries; the landing check needs a database this task cannot reach."
EXEMPT_REASON_2 = "Restarts services only; nothing the landing check builds changes."

# ① The coordinator's request with no line (P-M2): Automatic, at most 3, no merge check.
START_REQUEST = {
    "itemId": "I5", "kind": "START_REQUEST", "title": "Start this project?", "detailLine": "",
    "waitingSince": ago(12), "assignee": "OWNER",
    "startRequest": {
        "settings": {"automatic": True, "maxConcurrentTasks": 3, "mergeCheckCommand": None},
        "why": "Six tasks rotate the staging credentials; most change no code. The line is decided when "
               "the first task commits.",
        "criteriaDigest": DIGEST, "planDigest": "plan-p5", "repository": None, "warnings": []},
}

C5_EVENTS = [
    ("user", {"text": "Plan the credential rotation and ask me to start it."}, 20),
    ("assistant", {"text": "The plan is six tasks in three levels. It passed the ready check; asking you "
                           "to start.", "messageId": "m1"}, 12),
    ("result", {"subtype": "success", "result": "done"}, 12),
]


def events(sid):
    if sid != "C5":
        return []
    return [{"seq": i + 1, "type": typ, "ts": ago(minutes), "turnId": "t1", "payload": payload}
            for i, (typ, payload, minutes) in enumerate(C5_EVENTS)]


def membership(pid, role="TASK"):
    return {"projectId": pid, "projectTitle": TITLE, "projectStatus": "OPEN", "role": role}


def session(sid, title, *, status="SUCCEEDED", pid=None, role="TASK", text="", minutes=5, task=None,
            waiting=None):
    row = {"id": sid, "publicId": sid, "title": title, "status": status, "runStatus": status,
           "runState": status, "sessionState": status, "lifecycleState": "OPEN", "agentId": "a1",
           "agent": {"id": "a1", "name": "orbit-develop"}, "assignedRunnerId": "r1", "provider": "claude",
           "model": "claude-opus-5-5", "effort": "high", "permissionMode": "default", "taskId": task,
           "createdAt": ago(minutes + 30), "updatedAt": ago(minutes), "lastTurnAt": ago(minutes),
           "lastAssistantText": text, "tags": [], "folderId": None, "source": "USER",
           "pendingApprovals": 1 if waiting else 0, "waitingKind": waiting}
    if pid:
        row["projectId"] = pid if role == "COORDINATOR" else None
        row["projectTitle"] = TITLE
        row["projectMembership"] = membership(pid, role)
    return row


def sessions_of(pid):
    if pid == "P1":
        return [
            session("C1", TITLE, status="AWAITING_INPUT", pid="P1", role="COORDINATOR", minutes=0,
                    text="Two tasks running; the third waits on the password rotation."),
            session("S1", "Move cron jobs off the old VM", status="RUNNING", pid="P1", minutes=0,
                    text="Moved 4 of 6 cron jobs to the new scheduler.", task="P1T2"),
            session("S2", "Rotate the staging database password", pid="P1", minutes=9,
                    text="Rotated; services restarted.", task="P1T1"),
            session("S3", "Delete unused staging buckets", pid="P1", minutes=31,
                    text="Deleted 3 buckets; listed the rest.", task="P1T3"),
        ]
    if pid == "P5":
        return [session("C5", TITLE, status="AWAITING_INPUT", pid="P5", role="COORDINATOR", minutes=12,
                        text=C5_EVENTS[1][1]["text"], waiting="START_REQUEST")]
    return []


def change(cid, field, origin, old, new, minutes, *, reason=None, task=None, revertible=False,
           reverted=None, reverts=None):
    return {"id": cid, "projectId": "P3", "taskId": task, "field": field, "origin": origin,
            "oldValue": old, "newValue": new, "reason": reason,
            "writtenBySessionId": "C3" if origin == "COORDINATOR" else None,
            "revertsChangeId": reverts, "revertedAt": reverted, "revertible": revertible,
            "createdAt": ago(minutes)}


CMD = {"command": "npm run check:landing", "timeoutSeconds": None, "none": False}
NONE = {"command": None, "timeoutSeconds": None, "none": True}
MERGE = {"command": None, "timeoutSeconds": None, "none": False}

STATE = {}


def reset():
    STATE.clear()
    STATE.update(
        started={"P1": ago(2 * DAY), "P2": ago(3 * DAY), "P3": ago(3 * DAY), "P5": None},
        landing={
            # ③ the coordinator set this command 12 minutes ago, with no card (P-C1).
            "P2": {"command": "npm run check:landing", "setBy": "COORDINATOR", "setBySessionId": "C2",
                   "setAt": ago(12)},
            # ⑤ the coordinator turned it off 12 minutes ago: that is the change at the top of the list.
            "P3": {"command": "NONE", "setBy": "COORDINATOR", "setBySessionId": "C3", "setAt": ago(12)},
        },
        changes={
            "P2": [
                change("b1", "LANDING_CHECK", "COORDINATOR", MERGE, CMD, 12,
                       reason="The merge check builds everything; landings only need the migrations checked.",
                       revertible=True),
                change("b2", "TASK_LANDING_CHECK_EXEMPT", "COORDINATOR", {"exempt": False, "reason": None},
                       {"exempt": True, "reason": EXEMPT_REASON}, 20, reason=EXEMPT_REASON, task="T1",
                       revertible=True),
                change("b3", "LANDING_CHECK", "OWNER", NONE, MERGE, 2 * DAY),
            ],
            "P3": [
                change("c1", "LANDING_CHECK", "COORDINATOR", CMD, NONE, 12,
                       reason="This project only changes infrastructure; the command has nothing to build.",
                       revertible=True),
                change("c2", "TASK_LANDING_CHECK_EXEMPT", "COORDINATOR", {"exempt": False, "reason": None},
                       {"exempt": True, "reason": EXEMPT_REASON}, 20, reason=EXEMPT_REASON, task="T1",
                       revertible=True),
                change("c3", "LANDING_CHECK", "OWNER", MERGE, CMD, 2 * DAY),
                # ④ T2's exemption, approved on a card 7 minutes ago: the badge reads the record's origin.
                change("c4", "TASK_LANDING_CHECK_EXEMPT", "CARD", {"exempt": False, "reason": None},
                       {"exempt": True, "reason": EXEMPT_REASON_2}, 7, reason=EXEMPT_REASON_2, task="T2"),
            ],
        },
        exempt=True,
        exempt2=True,
        writes=[])


reset()


def landing_check(pid):
    return STATE["landing"].get(pid)


def settings_half(pid):
    started = STATE["started"][pid]
    if pid in ("P1", "P5"):
        # No line: no code binding, so no line, branch or checks (§12.16).
        return {"line": None, "lineAbsentReason": "NOT_DECIDED", "ref": None, "upstreamRef": None,
                "upstreamChosenAt": None, "lastMainBranch": None, "source": None, "locked": False,
                "startedAt": None, "mergeCheckCommand": None, "mergeCheckCommandAbsentReason": "NOT_CONFIGURED",
                "mergeCheckTimeoutSeconds": None, "landingCheckCommand": None,
                "landingCheckTimeoutSeconds": None, "landingCheckCommandAbsentReason": "FALLS_BACK_TO_MERGE_CHECK",
                "escalationSeconds": 7200}
    check = landing_check(pid)
    none = check["command"] == "NONE"
    return {"line": "PROJECT_BRANCH", "lineAbsentReason": None, "ref": BRANCH, "upstreamRef": "main",
            "upstreamChosenAt": ago(3 * DAY), "lastMainBranch": None, "source": "EXPLICIT", "locked": True,
            "startedAt": ago(3 * DAY), "mergeCheckCommand": "npm test", "mergeCheckCommandAbsentReason": None,
            "mergeCheckTimeoutSeconds": None,
            "landingCheckCommand": None if none else check["command"],
            "landingCheckTimeoutSeconds": None,
            "landingCheckCommandAbsentReason": "NONE" if none else (None if check["command"] else "FALLS_BACK_TO_MERGE_CHECK"),
            "landingCheck": check, "escalationSeconds": 7200}


def integration(pid):
    view = settings_half(pid)
    view.update({"repository": None if pid in ("P1", "P5") else "acme/staging-infra", "branches": None,
                 "commitsAheadOfUpstream": None if pid in ("P1", "P5") else 2,
                 "lastUpstreamSyncAt": None, "integratingCount": 0, "queuedCount": 0,
                 "mergeCheckOnTip": "UNKNOWN", "inFlight": None, "inFlightJobs": [], "landTasks": [],
                 "deliveryMode": "PLATFORM"})
    return view


def criterion(pid, ordinal, text):
    cid = "%sC%d" % (pid, ordinal)
    return {"id": cid, "publicId": cid, "key": cid, "ordinal": ordinal, "text": text, "satisfied": False,
            "unmet": [], "landing": "UNKNOWN", "verificationMethod": "A screenshot."}


def document(pid):
    doc = {"id": pid, "publicId": pid, "title": TITLE, "status": "OPEN",
           "goal": "Staging credentials are rotated and nothing reads the old ones.",
           "instructions": "Probe instructions.", "createdAt": ago(20 * DAY), "updatedAt": ago(5),
           "coordinatorEnabled": True, "configRevision": "1",
           "coordinatorSessionId": {"P1": "C1", "P5": "C5"}.get(pid, "C%s" % pid[1:]),
           "_count": {"tasks": 6}, "tasksByStatus": {"DONE": 3, "OPEN": 3},
           "acceptanceCriteriaItems": [criterion(pid, i + 1, t) for i, t in enumerate(CRITERIA)],
           "blockers": {"open": [], "resolved": [], "resolvedCount": 0},
           "integration": settings_half(pid), "startedAt": STATE["started"][pid], "pausedAt": None,
           "maxConcurrentTasks": 3, "exceptionEscalationSeconds": 7200, "rulings": []}
    if pid in STATE["changes"]:
        doc["settingChanges"] = STATE["changes"][pid]
    return doc


def summary(pid):
    return {"id": pid, "publicId": pid, "title": TITLE, "status": "OPEN",
            "goal": "Staging credentials are rotated.", "createdAt": ago(20 * DAY), "updatedAt": ago(5),
            "lastActivityAt": ago(0), "_count": {"tasks": 6}, "startedAt": STATE["started"][pid],
            "taskCounts": {"done": 3, "failed": 0, "total": 6}, "mainBranch": None}


def task_rows(pid):
    rows = []
    for i, title in enumerate(TASKS):
        tid = "T1" if (pid in ("P2", "P3") and i == 1) else "%sT%d" % (pid, i + 1)
        rows.append({"id": tid, "publicId": tid, "title": title, "status": "DONE" if i < 3 else "OPEN",
                     "parentTaskId": None, "childCount": 0, "unmetCount": 0, "blocksCount": 0,
                     "topoLevel": min(i, 2), "dependencyState": "READY", "workState": "IDLE",
                     "completionPolicy": "MANUAL", "autoRunWhenReady": True})
    return rows


def graph(pid):
    rows = task_rows(pid)
    marks = [{"kind": "TASK", "id": t["id"], "taskId": t["id"], "title": t["title"], "status": "OPEN",
              "completionCriterion": "EVIDENCE_JUDGMENT", "autoRunWhenReady": True} for t in rows]
    # Three levels: 1 → 2,3 → 4,5,6.
    edges = [("0", "1"), ("0", "2"), ("1", "3"), ("2", "4"), ("2", "5")]
    return {"marks": marks,
            "edges": [{"sourceMarkId": rows[int(a)]["id"], "targetMarkId": rows[int(b)]["id"]} for a, b in edges],
            "taskCount": len(rows), "truncated": False}


def confirmation(pid):
    material = [{"definitionId": "%sC%d" % (pid, i + 1), "revision": 1, "contentHash": "h%d" % i}
                for i in range(len(CRITERIA))]
    return {"state": "UNCONFIRMED", "confirmed": False, "currentVersion": {"digest": DIGEST, "material": material},
            "confirmation": None}


def panorama():
    return {"buckets": {"running": 1, "ready": 0, "blocked": 2, "awaitingVerification": 0, "done": 3,
                        "failed": 0, "cancelled": 0},
            "shape": {"taskCount": 6, "edgeCount": 5, "ratio": 5 / 6, "maxDepth": 3, "form": "tree"}}


# ④ the exempt task and its landing.
def task_item():
    exempt = STATE["exempt"]
    return {"id": "T1", "publicId": "T1", "title": "Move cron jobs off the old VM", "status": "DONE",
            "projectId": "P3", "description": "Move the staging cron jobs to the new scheduler.",
            "createdAt": ago(60), "updatedAt": ago(3), "completionCriterion": "EVIDENCE_JUDGMENT",
            "acceptanceCommand": "./cron-moved.sh", "acceptanceExpectedExitCode": 0,
            "project": {"id": "P3", "title": TITLE, "status": "OPEN"},
            "assignee": {"id": "a1", "name": "orbit-develop"},
            "landingCheckExempt": exempt,
            "landingCheckExemptReason": EXEMPT_REASON if exempt else None,
            "landingCheckExemptBySessionId": "C3" if exempt else None,
            "landingCheckExemptOwnerSetAt": None,
            "integration": {"state": "ON_INTEGRATION_LINE", "since": ago(3), "handler": None,
                            "openItemId": None, "jobId": "jL", "mainBranch": "main",
                            "landTask": {"jobId": "jL", "state": "LANDED", "phase": "PUSH",
                                         "landingSessionId": "L1", "generation": "1",
                                         "queuedAt": ago(6), "startedAt": ago(5.5), "heartbeatAt": ago(3),
                                         "finishedAt": ago(3), "targetRef": "refs/heads/" + BRANCH,
                                         "waitMs": 30_000, "blockingReason": None, "liveness": None,
                                         "runnerName": "orbit-develop"}}}


def task_item_2():
    """④ an exempt task with no landing yet: its page still has the Landing section, for the exemption."""
    exempt = STATE["exempt2"]
    return {"id": "T2", "publicId": "T2", "title": "Restart the staging services", "status": "OPEN",
            "projectId": "P3", "description": "Restart the staging services on the new password.",
            "createdAt": ago(60), "updatedAt": ago(3), "completionCriterion": "EVIDENCE_JUDGMENT",
            "project": {"id": "P3", "title": TITLE, "status": "OPEN"},
            "assignee": {"id": "a1", "name": "orbit-develop"},
            "landingCheckExempt": exempt,
            "landingCheckExemptReason": EXEMPT_REASON_2 if exempt else None,
            "landingCheckExemptBySessionId": "C3" if exempt else None,
            "landingCheckExemptOwnerSetAt": None}


def entry(kind, text, minutes, *, check=None, phase=None, data=None):
    return {"id": "e-%s-%s" % (kind, minutes), "seq": 1, "kind": kind, "at": ago(minutes), "claim": 1,
            "round": 1, "check": check, "phase": phase, "step": None, "actor": {"type": "PLATFORM"},
            "reason": None, "data": data, "text": text}


def landing_view():
    acceptance = {"name": "TASK_ACCEPTANCE", "index": 1, "count": 2}
    landing = {"name": "LANDING_CHECK", "index": 2, "count": 2}
    entries = [
        entry("ENQUEUED", "Queued · Landing", 6),
        entry("CLAIMED", "Claimed by runner orbit-develop · claim 1", 5.6),
        entry("STEP", "Fetched · synced main", 5.5, phase="FETCH"),
        entry("STEP", "Rebased onto " + BRANCH, 5.4, phase="REBASE"),
        entry("CHECK_STARTED", "Task acceptance started · claim 1 · orbit-develop", 5.3, check=acceptance),
        entry("CHECK_FINISHED", "Task acceptance passed · 14s", 5.1, check=acceptance,
              data={"exitCode": 0, "expectedExitCode": 0, "timedOut": False}),
        entry("CHECK_FINISHED", "Landing check skipped · this task is exempt: " + EXEMPT_REASON, 5.1,
              check=landing,
              data={"skipped": "TASK_EXEMPT", "reason": EXEMPT_REASON, "exitCode": None,
                    "expectedExitCode": 0, "timedOut": False}),
        entry("RESULT", "Landed on " + BRANCH + " · 8ed0ea7", 3, data={"state": "LANDED"}),
    ]
    return {"sessionId": "L1", "projectId": "P3", "subject": "TASK", "taskId": "T1", "promotionId": None,
            "episode": 1, "openedAt": ago(6), "settledAt": ago(3), "settledAs": "LANDED", "phase": "PUSH",
            "round": 1,
            "checks": [{"name": "TASK_ACCEPTANCE", "command": "./cron-moved.sh", "exitCode": 0,
                        "expectedExitCode": 0, "timedOut": False, "durationMs": 14_000},
                       {"name": "LANDING_CHECK", "skipped": "TASK_EXEMPT", "reason": EXEMPT_REASON,
                        "exitCode": None, "expectedExitCode": 0, "timedOut": False, "durationMs": 0}],
            "liveness": None, "blockingReason": None,
            "currentAttempt": {"jobId": "jL", "kind": "LAND_TASK", "state": "LANDED", "generation": 1,
                               "landingSessionId": "L1", "phase": "PUSH", "round": 1, "step": None,
                               "claim": 1, "runnerName": "orbit-develop", "sourceSessionId": "S9",
                               "targetRef": "refs/heads/" + BRANCH, "startedAt": ago(5.6),
                               "heartbeatAt": ago(3), "outputMovedAt": ago(3), "progressProtocol": "v2",
                               "check": None, "liveness": None, "blockingReason": None, "timedOut": False,
                               "limitSeconds": 600, "retryable": False, "pushBoundaryPassed": True},
            "todos": [],
            "generations": [{"sessionId": "L1", "episode": 1, "openedAt": ago(6), "settledAt": ago(3),
                             "settledAs": "LANDED"}],
            "timeline": {"sections": [{"title": "Landing · 1", "jobId": "jL", "kind": "LAND_TASK",
                                       "generation": 1, "state": "LANDED", "entries": entries}],
                         "facts": [], "truncated": False}}


def landing_session(detail):
    row = session("L1", "Land · Move cron jobs off the old VM", pid="P3", minutes=3)
    row["sessionKind"] = "LANDING"
    row["landing"] = landing_view() if detail else {"subject": "TASK", "state": "SETTLED",
                                                   "settledAs": "LANDED", "settledAt": ago(3)}
    return row


EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications",
         "wiki/spaces", "schedules"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        self.note(fmt % args)

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
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        query = parse_qs(url.query)
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
            project = (query.get("projectId") or [None])[0]
            if project:
                return self.send(200, sessions_of(project))
            return self.send(200, sessions_of("P1") + sessions_of("P5"))
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, more = parts[2], parts[3:]
            if sid == "L1":
                if more == []:
                    return self.send(200, landing_session(True))
                if more == ["landing", "log"]:
                    return self.send(200, {"jobId": "jL", "entries": [], "nextCursor": None})
            known = {s["id"]: s for s in sessions_of("P1") + sessions_of("P5")}
            if sid in known:
                if more == []:
                    return self.send(200, known[sid])
                if more == ["events"]:
                    return self.stream(events(sid))
                if more == ["events", "page"]:
                    return self.send(200, {"events": events(sid), "hasMore": False, "before": None, "after": None})
                if more in (["approvals"], ["turns"]):
                    return self.send(200, [])
                if more and more[0] in ("owner-items",):
                    return self.send(200, {"needsYou": [], "withCoordinator": []})

        if parts in (["api", "tasks", "T1"], ["api", "tasks", "T1", "row"]):
            return self.send(200, task_item())
        if parts in (["api", "tasks", "T2"], ["api", "tasks", "T2", "row"]):
            return self.send(200, task_item_2())
        if parts[:2] == ["api", "tasks"] and parts[2:3] in (["T1"], ["T2"]) \
                and parts[3:] in (["comments"], ["sessions"], ["evidence"]):
            return self.send(200, [])
        if parts == ["api", "tasks", "page"]:
            return self.send(200, {"items": [], "nextCursor": None})

        if parts in (["api", "projects"], ["api", "projects", "sidebar"]):
            return self.send(200, [summary(pid) for pid in PIDS])
        if len(parts) >= 3 and parts[:2] == ["api", "projects"] and parts[2] in PIDS:
            pid, rest = parts[2], parts[3:]
            if rest == []:
                return self.send(200, document(pid))
            if rest == ["integration"]:
                return self.send(200, integration(pid))
            if rest == ["tasks", "page"]:
                return self.send(200, {"items": task_rows(pid), "nextCursor": None})
            if rest == ["handoffs"]:
                return self.send(200, [])
            if rest == ["open-items"]:
                items = {"needsYou": [], "withCoordinator": [], "mainBranch": None}
                if pid == "P5" and not STATE["started"]["P5"]:
                    items["startRequest"] = START_REQUEST
                return self.send(200, items)
            if rest == ["acceptance", "confirmation"]:
                return self.send(200, confirmation(pid))
            if rest == ["dependency-graph"]:
                return self.send(200, graph(pid))
            if rest == ["panorama"]:
                return self.send(200, panorama())
            if rest == ["coordinator", "status"]:
                coordinator = document(pid)["coordinatorSessionId"]
                return self.send(200, {"projectId": pid, "state": "LIVE", "coordination": {"sessionId": coordinator},
                                       "openability": {"canOpen": True, "willCreate": False, "refusalCode": None,
                                                       "refusalDetail": None, "requiredAction": None}})
            if rest == ["promotions", "current"]:
                return self.send_null()
            if rest == ["promotions", "merged"]:
                return self.send(200, [])
            if rest == ["ready-to-run"]:
                return self.send(200, {"count": 0, "taskId": None, "title": None})
        if parts[:1] == ["api"] and len(parts) >= 2 and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        self.note("NOT SERVED %s" % self.path)
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def send_null(self):
        data = b"null"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def stream(self, frames):
        """SSE `data:` frames, then keepalives inside the clients' 45 s watchdog."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
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

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        self.note("BODY %s %s" % (self.path, json.dumps(body, sort_keys=True, ensure_ascii=False)))
        if parts == ["api", "projects", "P5", "start"]:
            return self.start(body)
        if len(parts) == 6 and parts[:2] == ["api", "projects"] and parts[3] == "setting-changes" \
                and parts[5] == "revert":
            return self.revert(parts[2], parts[4])
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def do_PATCH(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.body()
        self.note("BODY %s %s" % (self.path, json.dumps(body, sort_keys=True, ensure_ascii=False)))
        if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[2] in ("P2", "P3") \
                and parts[3] == "integration":
            return self.configure(parts[2], body)
        if parts == ["api", "tasks", "T1"]:
            if body.get("landingCheckExempt") is False:
                STATE["exempt"] = False
            return self.send(200, task_item())
        if parts == ["api", "tasks", "T2"]:
            if body.get("landingCheckExempt") is False:
                STATE["exempt2"] = False
            return self.send(200, task_item_2())
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

    def configure(self, pid, body):
        """The owner's own landing-check write: their value, stamped OWNER and now (§12.14)."""
        if body.get("landingCheck") == "NONE":
            STATE["landing"][pid] = {"command": "NONE", "setBy": "OWNER", "setBySessionId": None, "setAt": ago(0)}
        elif "landingCheckCommand" in body:
            STATE["landing"][pid] = {"command": body["landingCheckCommand"], "setBy": "OWNER",
                                     "setBySessionId": None, "setAt": ago(0)}
        return self.send(200, integration(pid))

    def revert(self, pid, cid):
        changes = STATE["changes"].get(pid, [])
        target = next((c for c in changes if c["id"] == cid), None)
        if not target or not target["revertible"]:
            return self.send(409, {"statusCode": 409, "code": "SETTING_CHANGE_NOT_REVERTIBLE",
                                   "message": "this change cannot be reverted. Nothing was written"})
        target["revertible"] = False
        target["revertedAt"] = ago(0)
        old = target["oldValue"]
        if target["field"] == "LANDING_CHECK":
            command = "NONE" if old["none"] else old["command"]
            STATE["landing"][pid] = {"command": command, "setBy": "OWNER", "setBySessionId": None, "setAt": ago(0)}
        row = change("r-" + cid, target["field"], "OWNER", target["newValue"], old, 0, task=target["taskId"],
                     reverts=cid)
        row["projectId"] = pid
        changes.insert(0, row)
        return self.send(201, row)

    def start(self, body):
        STATE["started"]["P5"] = ago(0)
        settings = {k: body[k] for k in ("line", "automatic", "maxConcurrentTasks", "mergeCheckCommand")
                    if k in body}
        return self.send(201, {"settings": settings, "differsFromRequest": [], "coordinator": None,
                               "projectId": "P5", "startedAt": STATE["started"]["P5"],
                               "criteriaDigest": body.get("criteriaDigest"), "criteriaCount": len(CRITERIA)})

    def refuse(self):
        self.body()
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})

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
    print("stub listening on 127.0.0.1:%d" % PORT, flush=True)
    Server(("127.0.0.1", PORT), Handler).serve_forever()
