#!/usr/bin/env python3
# TEMPORARY evidence probe (never merged): the slice of the Orbit API the native landing session
# page, the project sessions page, the task page and the Work overview read. A mode the UI test sets
# before each launch decides the attempt's state:
#
#   live      a merge check running, LIVE         -> status card + V6 rows + timeline
#   timeout   the claim past its lease            -> Timed out, Abandon / Re-run in the menu
#   settled   the round MERGED                    -> the outcome card, the receipt and the tree
#
# Every request is logged; anything not served is a 404 and lands in not-served.txt. All data is
# made up.
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
TITLES = {"P1": "Runner hardening"}
USER = {"id": "u1", "email": "hailong@example.com", "name": "Hailong", "role": "MEMBER",
        "createdAt": ago(90 * DAY), "preferences": {"theme": "system"}}
RUNNER = {"id": "r1", "name": "wikova", "displayName": "wikova", "online": True, "status": "ONLINE",
          "version": "0.1.240", "maxConcurrent": 4, "lastHeartbeatAt": ago(0), "capabilities": [],
          "engines": [{"engine": "claude", "installed": True, "version": "2.1.290", "auth": "yes"}]}
AGENT = {"id": "a1", "name": "orbit-macos", "provider": "claude", "lastProvider": "claude",
         "runnerId": "r1", "enabled": True, "enableWorktree": True, "effort": "",
         "workDir": "/srv/orbit", "appendSystemPrompt": "", "workDirExists": True, "workDirIsGit": True}

MEMBERSHIP = {"projectId": "P1", "projectTitle": TITLES["P1"], "projectStatus": "OPEN", "role": "TASK"}

C1 = {"id": "C1", "publicId": "C1", "title": "Runner hardening", "status": "AWAITING_INPUT",
      "runStatus": "AWAITING_INPUT", "runState": "AWAITING_INPUT", "sessionState": "AWAITING_INPUT",
      "agentId": "a1", "assignedRunnerId": "r1", "provider": "claude",
      "projectId": "P1", "projectTitle": TITLES["P1"],
      "projectMembership": dict(MEMBERSHIP, role="COORDINATOR"),
      "createdAt": ago(60), "updatedAt": ago(2), "lastTurnAt": ago(2)}

S4 = {"id": "S4", "publicId": "S4", "title": "Ledger migration order", "status": "SUCCEEDED",
      "runStatus": "SUCCEEDED", "runState": "SUCCEEDED", "sessionState": "SUCCEEDED",
      "agentId": "a1", "assignedRunnerId": "r1", "provider": "claude", "taskId": "T1",
      "projectId": "P1", "projectTitle": TITLES["P1"], "projectMembership": MEMBERSHIP,
      "createdAt": ago(40), "updatedAt": ago(12), "lastTurnAt": ago(12),
      "sourceLanding": {"landingSessionId": "L1", "subject": "PROMOTION", "state": "RUNNING",
                        "phase": "CHECK", "settledAs": None,
                        "targetRef": "refs/heads/project/P1"}}

L2 = {"id": "L2", "publicId": "L2", "title": "Land · Payout retry budget", "status": "SUCCEEDED",
      "runStatus": "SUCCEEDED", "runState": "SUCCEEDED", "sessionState": "SUCCEEDED",
      "sessionKind": "LANDING", "agentId": "a1", "assignedRunnerId": "r1",
      "projectId": "P1", "projectTitle": TITLES["P1"], "projectMembership": MEMBERSHIP,
      "createdAt": ago(130), "updatedAt": ago(120), "lastTurnAt": ago(120),
      "landing": {"subject": "TASK", "state": "SETTLED", "settledAs": "LANDED",
                  "settledAt": ago(120)}}
L3 = {"id": "L3", "publicId": "L3", "title": "Merge project/P1 → main · #1", "status": "SUCCEEDED",
      "runStatus": "SUCCEEDED", "runState": "SUCCEEDED", "sessionState": "SUCCEEDED",
      "sessionKind": "LANDING", "agentId": "a1", "assignedRunnerId": "r1",
      "projectId": "P1", "projectTitle": TITLES["P1"], "projectMembership": MEMBERSHIP,
      "createdAt": ago(26 * 60), "updatedAt": ago(26 * 60), "lastTurnAt": ago(26 * 60),
      "landing": {"subject": "PROMOTION", "state": "SETTLED", "settledAs": "NOTHING_TO_LAND",
                  "settledAt": ago(26 * 60)}}

STATE = {}
MODE = {"name": "live"}


def reset():
    STATE.clear()
    STATE.update(decisions=[])
    # The mode is set before each launch; resetting the write log must not lose it.


reset()


def attempt(mode):
    if mode == "settled" or mode == "receipt":
        return {"jobId": "jL", "kind": "LAND_PROMOTION", "state": "MERGED", "generation": 3,
                "phase": "PUSH", "round": 1, "step": None, "claim": 1, "runnerName": "wikova",
                "sourceSessionId": "S4", "targetRef": "refs/heads/project/P1",
                "startedAt": ago(12), "heartbeatAt": ago(10), "outputMovedAt": ago(10),
                "progressProtocol": "v2", "check": None, "liveness": None,
                "blockingReason": None, "timedOut": False, "limitSeconds": 600,
                "retryable": False, "pushBoundaryPassed": True}
    if mode == "task-timeout":
        # 05 i: a task segment's attempt whose runner stopped reporting; the server's Retry takes it.
        return {"jobId": "jL", "kind": "LAND_TASK", "state": "RUNNING", "generation": 3,
                "landingSessionId": "L1", "phase": "CHECK", "round": 1, "step": None, "claim": 1,
                "runnerName": "wikova", "sourceSessionId": "S4",
                "targetRef": "refs/heads/project/P1",
                "startedAt": ago(30), "heartbeatAt": ago(23), "outputMovedAt": ago(0.1),
                "progressProtocol": "v2",
                "check": {"name": "TASK_ACCEPTANCE", "index": 1, "count": 1,
                          "budgetSeconds": 1800, "startedAt": ago(30)},
                "liveness": "LEASE_EXPIRED", "blockingReason": None, "timedOut": True,
                "limitSeconds": 600, "retryable": True, "pushBoundaryPassed": False}
    timed = mode == "timeout"
    return {"jobId": "jL", "kind": "CHECK_PROMOTION", "state": "RUNNING", "generation": 3,
            "landingSessionId": "L1",
            "phase": "CHECK", "round": 1, "step": None, "claim": 1, "runnerName": "wikova",
            "sourceSessionId": "S4", "targetRef": "refs/heads/project/P1",
            "startedAt": ago(30 if timed else 110 / 60),
            "heartbeatAt": ago(23 if timed else 0),
            "outputMovedAt": ago(0.1),
            "progressProtocol": "v2",
            "check": {"name": "MERGE_CHECK", "index": 1, "count": 3, "budgetSeconds": 3600,
                      "startedAt": ago(30 if timed else 110 / 60)},
            "liveness": "LEASE_EXPIRED" if timed else "LIVE",
            "blockingReason": None, "timedOut": timed, "limitSeconds": 600,
            "retryable": False, "pushBoundaryPassed": False}


def entry(kind, text, minutes, *, claim=1, round=None, phase=None, check=None, reason=None):
    return {"id": "e-%s-%s" % (kind, minutes), "seq": 1, "kind": kind, "at": ago(minutes),
            "claim": claim, "round": round, "check": check, "phase": phase, "step": None,
            "actor": {"type": "PLATFORM"}, "reason": reason, "data": None, "text": text}


def landing(mode):
    settled = mode == "settled" or mode == "receipt"
    if mode == "task-timeout":
        entries = [
            entry("ENQUEUED", "Queued · Landing", 30),
            entry("CLAIMED", "Claimed by runner wikova · claim 1", 30),
            entry("STEP", "Fetched · synced main", 29, phase="FETCH"),
            entry("STEP", "Rebased onto main", 28, phase="REBASE"),
            entry("CHECK_STARTED", "Task acceptance started · round 1", 27,
                  check={"name": "TASK_ACCEPTANCE", "index": 1}),
        ]
        return {
            "sessionId": "L1", "projectId": "P1", "subject": "TASK", "taskId": "T1",
            "promotionId": None, "episode": 1, "openedAt": ago(30), "settledAt": None,
            "settledAs": None, "phase": "CHECK", "round": 1, "checks": [],
            "liveness": "LEASE_EXPIRED", "blockingReason": None,
            "currentAttempt": attempt(mode), "todos": [],
            "generations": [{"sessionId": "L1", "episode": 1, "openedAt": ago(30),
                             "settledAt": None, "settledAs": None}],
            "timeline": {"sections": [{"title": "Landing · 1", "jobId": "jL", "kind": "LAND_TASK",
                                       "generation": 1, "state": "RUNNING", "entries": entries}],
                         "facts": [], "truncated": False},
        }
    if settled:
        entries = [
            entry("CLAIMED", "Claimed by runner wikova · claim 1", 12),
            entry("STEP", "Fetched · synced main", 11, phase="FETCH"),
            entry("CHECK_STARTED", "Merge check started · round 1", 10,
                  check={"name": "MERGE_CHECK", "index": 1}),
            entry("CHECK_FINISHED", "Merge check passed · 17m 41s", 10,
                  check={"name": "MERGE_CHECK", "index": 1}),
            entry("RESULT", "Merged into main · 8ed0ea7", 9),
        ]
        section = {"title": "Merge to main · 1", "jobId": "jL", "kind": "LAND_PROMOTION",
                   "generation": 1, "state": "MERGED", "entries": entries}
    else:
        entries = [
            entry("ENQUEUED", "Queued · Merge check", 30 if mode == "timeout" else 2),
            entry("CLAIMED", "Claimed by runner wikova · claim 1", 30 if mode == "timeout" else 110 / 60),
            entry("STEP", "Fetched · synced main", 29 if mode == "timeout" else 1.6, phase="FETCH"),
            entry("STEP", "Rebased onto main", 28 if mode == "timeout" else 1.5, phase="REBASE"),
            entry("CHECK_STARTED", "Merge check started · round 1", 27 if mode == "timeout" else 1.4,
                  check={"name": "MERGE_CHECK", "index": 1}),
        ]
        section = {"title": "Merge check · 1", "jobId": "jL", "kind": "CHECK_PROMOTION",
                   "generation": 1, "state": "RUNNING", "entries": entries}
    return {
        "sessionId": "L1", "projectId": "P1", "subject": "PROMOTION", "taskId": None,
        "promotionId": "PM1", "episode": 3,
        "openedAt": ago(12 if settled else 30),
        "settledAt": ago(9) if settled else None,
        "settledAs": "MERGED" if settled else None,
        "phase": "CHECK", "round": 1,
        "checks": [{"name": "MERGE_CHECK", "command": "npm test", "exitCode": 0,
                    "expectedExitCode": 0, "timedOut": False, "durationMs": 17 * 60_000 + 41_000}]
        if settled else [],
        "liveness": None if settled else ("LEASE_EXPIRED" if mode == "timeout" else "LIVE"),
        "blockingReason": None, "currentAttempt": attempt(mode), "todos": [],
        "generations": [{"sessionId": "L1", "episode": 3, "openedAt": ago(12),
                         "settledAt": ago(9) if settled else None,
                         "settledAs": "MERGED" if settled else None}],
        "timeline": {"sections": [section], "facts": [], "truncated": False},
    }


def landing_row(mode, detail=False):
    settled = mode == "settled" or mode == "receipt"
    task = mode == "task-timeout"
    row = dict(L1_ROW)
    row["status"] = "SUCCEEDED" if settled else "RUNNING"
    row["runStatus"] = row["status"]
    if task:
        row["title"] = "Land · Ledger migration order"
    row["landing"] = {"subject": "TASK" if task else "PROMOTION",
                      "state": "SETTLED" if settled else "AWAITING_DECISION",
                      "settledAs": "MERGED" if settled else None,
                      "settledAt": ago(9) if settled else None}
    if detail:
        # The detail read carries the whole view under the same key; the list row its summary.
        row["landing"] = landing(mode)
    return row


L1_ROW = {"id": "L1", "publicId": "L1", "title": "Merge project/P1 → main · #3",
          "status": "RUNNING", "runStatus": "RUNNING", "runState": "RUNNING",
          "sessionState": "RUNNING", "sessionKind": "LANDING", "agentId": "a1",
          "assignedRunnerId": "r1", "projectId": "P1", "projectTitle": TITLES["P1"],
          "projectMembership": MEMBERSHIP, "createdAt": ago(30), "updatedAt": ago(0),
          "lastTurnAt": ago(0)}


def promotion(mode):
    # The sessions page's own cards: a task landing has no merge candidate at all.
    if mode in ("one-job", "two-jobs", "task-timeout"):
        return None
    settled = mode in ("settled", "receipt")
    confirmed = mode in ("confirmed", "cancelling", "land-timeout")
    view = {"promotionId": "PM1",
            "state": "MERGED" if settled else "CONFIRMED" if confirmed else "CHECKING",
            "sourceKind": "PROJECT_BRANCH", "sourceRef": "refs/heads/project/P1",
            "sourceSha": "a" * 40, "upstreamRef": "refs/heads/main",
            "commitsAhead": 2, "filesChanged": 3,
            "tasks": [{"taskId": "T1", "title": "Ledger migration order"},
                      {"taskId": "T2", "title": "Payout retry budget"}],
            "taskIds": ["T1", "T2"], "checks": [], "conflicts": [], "blockedReason": None,
            "upstreamShaChecked": "b" * 40, "landsTreeSha": "5e5bfca" + "0" * 33,
            "landsAs": "MERGE_COMMIT", "askedAt": None, "recheckedAt": None, "decidedAt": None,
            "landingSessionId": "L1", "onPass": "MERGE",
            "cancelRequested": mode == "cancelling", "pushBoundaryPassed": False,
            "execution": {"state": "RUNNING", "phase": "CHECK", "startedAt": ago(3)}
            if confirmed else None,
            "merged": {"sha": "8ed0ea7" + "0" * 33, "at": ago(9), "automatic": True,
                       "byUserId": None, "revert": None} if settled else None}
    return view


def task_item(mode):
    timed = mode == "timeout"
    settled = mode == "settled"
    return {"id": "T1", "title": "Ledger migration order", "status": "DONE",
            "projectId": "P1", "description": "", "createdAt": ago(40), "updatedAt": ago(6),
            "project": {"id": "P1", "title": TITLES["P1"], "status": "OPEN"},
            "assignee": {"id": "a1", "name": "orbit-macos"},
            "integration": {"state": "RUNNING" if not settled else "ON_INTEGRATION_LINE",
                            "since": ago(6), "handler": None, "openItemId": None,
                            "jobId": "jL", "checksRunningForMs": 60_000, "mainBranch": "main",
                            "landTask": {"jobId": "jL",
                                         "state": "LANDED" if settled else "RUNNING",
                                         "phase": "CHECK",
                                         "landingSessionId": "L1", "generation": "3",
                                         "queuedAt": ago(7), "startedAt": ago(6),
                                         "heartbeatAt": ago(23 if timed else 0),
                                         "finishedAt": None,
                                         "targetRef": "refs/heads/project/P1",
                                         "waitMs": 60_000, "blockingReason": None,
                                         "liveness": "LEASE_EXPIRED" if timed else "LIVE",
                                         "runnerName": "wikova"}}}


def summary(pid, done, total):
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": "OPEN",
            "goal": "Probe goal for " + TITLES[pid] + ".", "createdAt": ago(20 * DAY),
            "updatedAt": ago(30), "lastActivityAt": ago(30), "_count": {"tasks": total},
            "startedAt": ago(19 * DAY),
            "taskCounts": {"done": done, "failed": 1, "total": total}}


def document(pid):
    return {"id": pid, "publicId": pid, "title": TITLES[pid], "status": "OPEN",
            "goal": "Runners stay healthy on their own.", "instructions": "Probe instructions.",
            "createdAt": ago(20 * DAY), "updatedAt": ago(30), "coordinatorEnabled": True,
            "configRevision": "1", "coordinatorSessionId": "C1",
            "_count": {"tasks": 3}, "tasksByStatus": {"DONE": 1, "FAILED": 2},
            "acceptanceCriteriaItems": [], "blockers": {"open": [], "resolved": [], "resolvedCount": 0},
            "startedAt": ago(19 * DAY), "pausedAt": None, "maxConcurrentTasks": 3}


_NO_BODY = object()

TASK_TITLE = "Ledger migration order"


def job(job_id, kind, *, state="RUNNING", phase="CHECK", task_title=None, timed=False,
        retryable=False, liveness="LIVE", landing="L1", heartbeat=0, started=None):
    """One job in flight, shaped as `GET /projects/:id/integration` serves it. A merge job lands
    no single task, so it carries neither a task id nor a title (§2.9) — never attribute one from
    a promotion row."""
    started = started if started is not None else 110 / 60
    check_name = "TASK_ACCEPTANCE" if kind == "LAND_TASK" else "MERGE_CHECK"
    entry = {"jobId": job_id, "kind": kind, "state": state,
             "phase": phase if state == "RUNNING" else None, "generation": 1,
             "startedAt": ago(started),
             "queuedAt": ago(started + 0.5), "heartbeatAt": ago(heartbeat),
             "runnerName": "wikova" if state == "RUNNING" else None, "retriedBy": None,
             "timedOut": timed, "limitSeconds": 600 if state == "RUNNING" else None,
             "retryable": retryable, "claim": 1 if state == "RUNNING" else 0, "round": 1,
             "check": {"name": check_name, "index": 1, "count": 1 if kind == "LAND_TASK" else 3,
                       "budgetSeconds": 1800 if kind == "LAND_TASK" else 3600,
                       "startedAt": ago(started)} if state == "RUNNING" else None,
             "stepStartedAt": ago(started), "outputMovedAt": ago(0.1),
             "progressProtocol": "v2", "typicalMs": 18 * 60_000 if kind == "CHECK_PROMOTION" else None,
             "liveness": liveness if state == "RUNNING" else None,
             "landingSessionId": landing}
    if kind == "LAND_TASK" and task_title:
        entry["taskId"] = "T1"
        entry["taskTitle"] = task_title
    return entry


def land_tasks(jobs):
    """Each task's newest LAND_TASK — only task landings have one; a merge job has none."""
    out = []
    for entry in jobs:
        if entry["kind"] != "LAND_TASK":
            continue
        out.append({"taskId": entry.get("taskId"),
                    "taskTitle": entry.get("taskTitle"),
                    "integration": {"state": "RUNNING", "jobId": entry["jobId"],
                                    "landTask": {"jobId": entry["jobId"],
                                                 "state": entry["state"], "phase": "CHECK",
                                                 "landingSessionId": entry["landingSessionId"],
                                                 "generation": "3",
                                                 "targetRef": "refs/heads/project/P1",
                                                 "startedAt": entry["startedAt"]}}})
    return out


def integration(mode):
    if mode in ("settled", "receipt"):
        jobs = []
    elif mode == "one-job":
        jobs = [job("j-task", "LAND_TASK", task_title=TASK_TITLE, landing="LT")]
    elif mode == "two-jobs":
        jobs = [job("j-task", "LAND_TASK", task_title=TASK_TITLE, landing="LT"),
                job("j-check", "CHECK_PROMOTION", state="QUEUED", landing="L1")]
    elif mode == "merge-two":
        # The merge round leads; the task landing queued behind it keeps its way in at the foot.
        jobs = [job("jL", "CHECK_PROMOTION"),
                job("j-task", "LAND_TASK", state="QUEUED", task_title=TASK_TITLE, landing="LT")]
    elif mode == "timeout":
        jobs = [job("jL", "CHECK_PROMOTION", timed=True, liveness="LEASE_EXPIRED",
                    heartbeat=23, started=30)]
    elif mode == "land-timeout":
        jobs = [job("j-merge", "LAND_PROMOTION", phase="REBASE", timed=True,
                    liveness="LEASE_EXPIRED", heartbeat=23, started=30)]
    elif mode in ("confirmed", "cancelling"):
        jobs = [job("j-merge", "LAND_PROMOTION")]
    elif mode == "task-timeout":
        jobs = [job("jL", "LAND_TASK", task_title=TASK_TITLE, timed=True,
                    liveness="LEASE_EXPIRED", heartbeat=23, retryable=True, started=30)]
    else:  # live
        jobs = [job("jL", "CHECK_PROMOTION")]
    lead = jobs[0] if jobs else None
    flight = None
    if lead:
        flight = {k: lead.get(k) for k in ("taskTitle", "kind", "state", "phase", "startedAt",
                                           "heartbeatAt", "jobId", "landingSessionId", "taskId",
                                           "runnerName", "claim", "round", "check", "stepStartedAt",
                                           "outputMovedAt", "progressProtocol", "typicalMs",
                                           "liveness")}
        flight["runner"] = lead.get("runnerName")
        flight["waitMs"] = 60_000
    return {"line": "PROJECT_BRANCH", "ref": "project/P1", "upstreamRef": "main",
            "integratingCount": sum(1 for j in jobs if j["state"] == "RUNNING"),
            "queuedCount": sum(1 for j in jobs if j["state"] == "QUEUED"),
            "mergeCheckOnTip": "PASSING" if mode in ("settled", "receipt") else "UNKNOWN",
            "inFlight": flight, "inFlightJobs": jobs, "landTasks": land_tasks(jobs)}


X5 = {"itemId": "OI5", "kind": "LANDING_LEASE_EXPIRED",
      "title": "Merge check stopped reporting",
      "detailLine": "The runner stopped reporting while checking the combined tree.",
      "waitingSince": ago(28), "assignee": "OWNER", "assigneeReason": "ESCALATED",
      "escalateAt": None, "escalatedAt": ago(0),
      "taskId": "T1", "sessionId": "S4", "promotionId": "PM1",
      "landingSessionId": "L1", "integrationJobId": "jL",
      "actions": ["ABANDON", "OPEN_LANDING"], "primaryAction": "ABANDON",
      "requiredAction": "The runner stopped reporting; abandon this landing, or wait for the runner to come back.",
      "facts": {"task": {"id": "T1", "title": "Ledger migration order"}},
      "lease": {"lastReportAt": ago(27), "leaseExpiredAt": ago(17), "jobKind": "CHECK_PROMOTION",
                "generation": 3, "phase": "CHECK", "step": None, "claimGeneration": 1,
                "round": 1, "checkCount": 3, "runner": "wikova", "progressProtocol": "v2",
                "pushReported": False}}

def delivery_event():
    """The `user` event an exception item's delivery leaves in the source conversation (06 b): the
    paragraph the agent was told, and the fields its card is drawn from."""
    return {"seq": 1, "type": "user", "ts": ago(6), "turnId": "t1",
            "payload": {
                "text": "Exception item delivered to the coordinator.",
                "openItemDelivery": {
                    "itemId": "OI9", "kind": "INTEGRATION_CHECK_FAILED",
                    "title": "Checks failed on the combined tree",
                    "task": {"id": "T1", "title": "Ledger migration order", "sessionId": "S4"},
                    "targetRef": "refs/heads/project/P1",
                    "check": {"name": "MERGE_CHECK", "exitCode": 1, "expectedExitCode": 0},
                    "actions": ["OPEN_LANDING"],
                    "landingSessionId": "LT",
                }}}


OPEN_ITEM = {"itemId": "OI1", "kind": "INTEGRATION_CHECK_FAILED",
             "title": "Merge check failed", "detailLine": "",
             "waitingSince": ago(25), "assignee": "COORDINATOR",
             "assigneeReason": "DEFAULT", "escalateAt": ago(-5), "escalatedAt": None,
             "taskId": "T1", "sessionId": "S4", "promotionId": "PM1",
             "landingSessionId": "L1", "integrationJobId": "jL",
             "actions": ["OPEN_LANDING", "REVIEW"],
             "primaryAction": "OPEN_LANDING", "delivery": None}


EMPTY = ["providers", "providers/mine", "providers/pools", "providers/shared-pools", "session-tags",
         "session-folders", "task-lists", "watches", "tasks/active", "tasks/counts", "notifications",
         "wiki/spaces"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def note(self, line):
        with open(LOG, "a") as f:
            f.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), line))

    def send(self, status, body=_NO_BODY):
        # `null` is a body: the promotions door answers a bare JSON null for "asking nothing",
        # which is not the same as an empty response.
        data = b"" if body is _NO_BODY else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path)
        parts = [p for p in path.path.split("/") if p]
        query = parse_qs(path.query)
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
            project = (query.get("projectId") or [None])[0]
            include = (query.get("includeLanding") or ["0"])[0] == "1"
            if project == "P1":
                rows = [C1, S4] + ([landing_row(MODE["name"]), L2, L3] if include else [])
            else:
                rows = [C1, S4]
            return self.send(200, rows)
        if len(parts) >= 3 and parts[:2] == ["api", "sessions"]:
            sid, more = parts[2], parts[3:]
            if sid == "L1":
                if more == []:
                    return self.send(200, landing_row(MODE["name"], detail=True))
                if more == ["landing", "log"]:
                    return self.send(200, {
                        "jobId": "jL",
                        "entries": [
                            {"jobId": "jL", "claim": 1, "round": 1,
                             "check": {"name": "MERGE_CHECK", "index": 1}, "seq": 0,
                             "text": "> orbit@1.0.0 test\n> vitest run\n\n", "truncatedBytes": 0,
                             "at": ago(10)},
                            {"jobId": "jL", "claim": 1, "round": 1,
                             "check": {"name": "MERGE_CHECK", "index": 1}, "seq": 1,
                             "text": " ✓ src/ledger/migrate.test.ts (12 tests)\n", "truncatedBytes": 0,
                             "at": ago(10)},
                        ],
                        "nextCursor": None})
            row = {"S4": S4, "C1": C1}.get(sid)
            if row is not None:
                if more == []:
                    return self.send(200, row)
                if more == ["events", "page"]:
                    # One delivered exception item's card (06 b), in the "delivery" mode: the
                    # `user` event the control plane records beside the turn's echo.
                    if MODE["name"] == "delivery" and sid == "S4":
                        return self.send(200, {"events": [delivery_event()], "hasMore": False})
                    return self.send(200, {"events": [], "hasMore": False})
                if more == ["events"]:
                    return self.send(200, {"items": [], "nextCursor": None, "events": []})
                if more[0] in ("retry-message", "capabilities", "owner-confirmation", "watches",
                               "owner-items", "attribution", "created-tasks", "turns"):
                    body = {}
                    if more[0] == "owner-items":
                        body = {"needsYou": [], "withCoordinator": []}
                    if more[0] == "turns":
                        body = []
                    return self.send(200, body)

        if parts == ["api", "tasks", "T1"] or parts == ["api", "tasks", "T1", "row"]:
            return self.send(200, task_item(MODE["name"]))
        if parts[:3] == ["api", "tasks", "T1"] and parts[3:] in (["comments"], ["sessions"]):
            return self.send(200, [])
        if parts == ["api", "tasks", "page"]:
            return self.send(200, {"items": [], "nextCursor": None})

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
                    return self.send(200, {"items": [], "nextCursor": None})
                if rest[1:] == ["open-items"]:
                    # The owner's own card reads `needsYou`; the group's holder read is the
                    # coordinator's item. The "lease" mode opens X-E5 in the coordinator console.
                    if MODE["name"] == "lease":
                        return self.send(200, {"needsYou": [X5], "withCoordinator": []})
                    return self.send(200, {"needsYou": [], "withCoordinator": [OPEN_ITEM]})
                if rest[1:] == ["handoffs"]:
                    return self.send(200, [])
                if rest[1:] == ["panorama"]:
                    return self.send(200, {"buckets": {"running": 0, "ready": 0, "blocked": 0,
                                                       "awaitingVerification": 0, "done": 44,
                                                       "failed": 0, "cancelled": 0,
                                                       "integrating": 1, "onIntegrationLine": 0,
                                                       "onUpstream": 44, "doneNotIntegrated": 0,
                                                       "waitingForLanding": 0},
                                           "shape": {"taskCount": 46, "edgeCount": 51,
                                                     "ratio": 51 / 46, "maxDepth": 12, "form": "chain"}})
                if rest[1:] == ["integration"]:
                    return self.send(200, integration(MODE["name"]))
                if rest[1:] == ["coordinator", "status"]:
                    return self.send(200, {"projectId": "P1", "state": "LIVE",
                                           "coordination": {"sessionId": "C1"},
                                           "openability": {"canOpen": True, "willCreate": False,
                                                           "refusalCode": None,
                                                           "refusalDetail": None,
                                                           "requiredAction": None}})
                if rest[1:] == ["promotions", "current"]:
                    return self.send(200, promotion(MODE["name"]))
                if rest[1:] == ["promotions", "merged"]:
                    return self.send(200, [promotion(MODE["name"])]
                                     if MODE["name"] in ("settled", "receipt") else [])
                if rest[1:] == ["ready-to-run"]:
                    return self.send(200, {"count": 0, "taskId": None, "title": None})

        if parts[:1] == ["api"] and len(parts) >= 2 and "/".join(parts[1:]) in EMPTY:
            return self.send(200, [])
        if len(parts) == 2 and parts[0] == "__mode":
            MODE["name"] = parts[1]
            self.note("MODE %s" % parts[1])
            return self.send(200, {"mode": parts[1]})
        self.note("NOT SERVED %s" % self.path)
        return self.send(404, {"statusCode": 404, "message": "not in the probe"})

    def stream(self):
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
        if parts == ["__reset"]:
            reset()
            return self.send(200, {"ok": True})
        self.note("POST %s" % self.path)
        if parts[:2] == ["api", "projects"] and parts[-1] in ("retry", "abandon", "stop", "cancel"):
            STATE["decisions"].append((parts[-1], self.path))
            return self.send(200, {"ok": True})
        self.note("NOT A PRESS %s" % self.path)
        return self.send(409, {"statusCode": 409, "code": "PROBE_PRESSES_NOTHING",
                               "message": "the probe does not run anything"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    # HTTPServer.server_bind resolves its own name (socket.getfqdn), a reverse lookup that on macOS
    # raises the "Allow Python to find devices on your local network?" prompt over the picture.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


if __name__ == "__main__":
    Server(("127.0.0.1", PORT), Handler).serve_forever()
